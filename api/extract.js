/* GET /api/extract?url=<page>
 *
 * Loads a page server-side and reports every media reference on it, so the
 * app can offer a stream to play or cast. Browsers can't do this themselves:
 * cross-origin pages are unreadable from client JS, and nearly every site
 * refuses to be framed.
 *
 * This runs a fetch and a parse, not a browser. Media injected later by a
 * player script is not visible here, and the response says so honestly
 * rather than pretending the page has nothing.
 */

const dns = require('dns').promises;
const net = require('net');

const FETCH_TIMEOUT_MS = 9000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const MAX_RESULTS = 40;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 CastBridge/1.0';

const MEDIA_EXT =
  /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|mp3|m4a|aac|ogg|opus|flac|wav)(\?[^"'\s\\<>]*)?$/i;

/* ------------------------------------------------------------------ *
 * Address safety
 *
 * The scanner fetches a URL the caller chose, so it must not be usable as
 * a way to reach anything private: loopback, LAN, link-local, or a cloud
 * metadata endpoint. Every redirect hop is checked too, because a public
 * host can redirect straight to 169.254.169.254.
 * ------------------------------------------------------------------ */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique local
    if (s.startsWith('fe80')) return true; // link-local
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7)); // v4-mapped
    return false;
  }
  return true;
}

async function assertPublic(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    throw new Error('That address is not valid.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be scanned.');
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('That address points inside a private network.');
    return u;
  }
  if (/^localhost$/i.test(host) || /\.local$/i.test(host) || /\.internal$/i.test(host)) {
    throw new Error('That address points inside a private network.');
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error("That site's address couldn't be resolved.");
  }
  if (!records.length) throw new Error("That site's address couldn't be resolved.");
  for (const r of records) {
    if (isPrivateIp(r.address)) throw new Error('That address points inside a private network.');
  }
  return u;
}

/* Follow redirects by hand so every hop gets the same check. */
async function safeFetch(startUrl, accept) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          accept: accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9'
        }
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('That page took too long to answer.');
      throw new Error("That page couldn't be reached.");
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { res, url };
      url = new URL(loc, url).toString();
      continue;
    }
    return { res, url };
  }
  throw new Error('That page redirects too many times.');
}

async function readCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total >= MAX_BYTES) {
      try { await reader.cancel(); } catch (e) { /* already closed */ }
      break;
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

function absolute(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch (e) {
    return null;
  }
}

function kindOf(u) {
  const p = String(u).split('?')[0].split('#')[0].toLowerCase();
  if (/\.m3u8$/.test(p)) return 'HLS';
  if (/\.mpd$/.test(p)) return 'DASH';
  if (/\.(mp3|m4a|aac|opus|flac|wav)$/.test(p)) return 'AUDIO';
  const ext = (p.match(/\.([a-z0-9]{2,5})$/) || [])[1];
  return ext ? ext.toUpperCase() : 'VIDEO';
}

/* A stream that is not a plain progressive file, or a bigger file, is more
   likely to be the thing the visitor came for — rank those first. */
function rank(m) {
  const k = m.kind;
  if (k === 'HLS') return 0;
  if (k === 'DASH') return 1;
  if (k === 'MP4' || k === 'M4V') return 2;
  if (k === 'WEBM' || k === 'MOV' || k === 'MKV') return 3;
  if (k === 'AUDIO') return 5;
  return 4;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extract(html, baseUrl) {
  const found = new Map();

  const add = (raw, source, label) => {
    if (!raw) return;
    const abs = absolute(decodeEntities(String(raw).replace(/\\\//g, '/').trim()), baseUrl);
    if (!abs) return;
    if (found.has(abs)) return;
    /* The PATH must end in a media extension. A query string that merely
       mentions one (api.php?title=File%3Aclip.webm) is a page, not a file.
       A last segment carrying a colon is a wiki namespace page, same. */
    const seg = abs.split('?')[0].split('/').pop() || '';
    if (seg.indexOf(':') !== -1) return;
    if (!/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|mp3|m4a|aac|ogg|opus|flac|wav)$/i.test(seg)) return;
    if (found.size >= MAX_RESULTS * 3) return;
    found.set(abs, { url: abs, kind: kindOf(abs), src: source, label: label || null });
  };

  /* <video src> / <audio src> / <source src> / <embed src> */
  const tagSrc = /<(video|audio|source|embed)\b[^>]*?\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = tagSrc.exec(html))) add(m[2], m[1].toLowerCase() + ' tag');

  /* data-src / data-video / data-file, common on lazy players */
  const dataSrc = /\sdata-(?:src|video|file|stream|hls|mp4)\s*=\s*["']([^"']+)["']/gi;
  while ((m = dataSrc.exec(html))) add(m[1], 'data attribute');

  /* <video poster> is not media, but it makes a nice preview. */
  let poster = null;
  const posterMatch = /<video\b[^>]*?\sposter\s*=\s*["']([^"']+)["']/i.exec(html);
  if (posterMatch) poster = absolute(decodeEntities(posterMatch[1]), baseUrl);

  /* Open Graph and Twitter player metadata */
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    const tag = m[0];
    const prop = (/\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    const content = (/\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    if (!prop || !content) continue;
    const p = prop.toLowerCase();
    if (p === 'og:video' || p === 'og:video:url' || p === 'og:video:secure_url' ||
        p === 'twitter:player:stream' || p === 'video:url') {
      add(content, 'page metadata');
    }
    if (!poster && (p === 'og:image' || p === 'twitter:image')) {
      poster = absolute(decodeEntities(content), baseUrl);
    }
  }

  /* <link rel="alternate" type="application/x-mpegURL"> */
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    if (!/application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)/i.test(tag)) continue;
    const href = (/\bhref\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    add(href, 'link tag');
  }

  /* JSON-LD VideoObject */
  const ldRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.contentUrl) add(node.contentUrl, 'structured data', node.name || null);
      if (node.embedUrl && MEDIA_EXT.test(String(node.embedUrl))) {
        add(node.embedUrl, 'structured data', node.name || null);
      }
      Object.keys(node).forEach((k) => walk(node[k]));
    };
    walk(data);
  }

  /* Anything file-shaped anywhere in the markup or its inline scripts.
     Player configs live in inline JSON far more often than in attributes. */
  const loose = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv|mov|mp3|m4a|aac|ogg|opus|flac|wav)(?:\?[^\s"'<>\\)]*)?/gi;
  while ((m = loose.exec(html))) add(m[0], 'page source');

  /* Relative playlist paths, e.g. src: "/hls/master.m3u8" */
  const rel = /["'](\/[^"'\s<>]+?\.(?:m3u8|mpd|mp4|m4v|webm)(?:\?[^"'\s<>]*)?)["']/gi;
  while ((m = rel.exec(html))) add(m[1], 'page source');

  const title = decodeEntities(
    ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '').trim()
  ).slice(0, 160);

  const media = Array.from(found.values())
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_RESULTS)
    .map((x) => ({
      url: x.url,
      kind: x.kind,
      label: x.label || labelFor(x.url),
      detail: x.src
    }));

  return { title, poster, media };
}

function labelFor(u) {
  try {
    const p = new URL(u);
    const last = p.pathname.split('/').filter(Boolean).pop() || p.host;
    const clean = decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[._-]+/g, ' ').trim();
    return (clean || p.host).slice(0, 80);
  } catch (e) {
    return String(u).slice(0, 80);
  }
}

/* An HLS master playlist lists its own variants — worth one extra fetch so
   the quality options are real rather than guessed. */
async function expandHlsMaster(playlistUrl) {
  let text;
  try {
    const { res, url } = await safeFetch(playlistUrl, 'application/vnd.apple.mpegurl,*/*');
    if (!res.ok) return [];
    text = (await readCapped(res)).slice(0, 256 * 1024);
    playlistUrl = url;
  } catch (e) {
    return [];
  }
  if (!/#EXTM3U/.test(text)) return [];

  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const res = (/RESOLUTION=(\d+)x(\d+)/i.exec(line) || [])[2];
    const bw = (/BANDWIDTH=(\d+)/i.exec(line) || [])[1];
    const next = (lines[i + 1] || '').trim();
    if (!next || next.startsWith('#')) continue;
    const abs = absolute(next, playlistUrl);
    if (!abs) continue;
    out.push({
      url: abs,
      kind: 'HLS',
      label: res ? res + 'p' : bw ? Math.round(Number(bw) / 1000) + 'k' : 'variant',
      detail: 'stream variant'
    });
  }
  return out.slice(0, 12);
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Services we cannot cast, and should say so plainly
 *
 * Two different reasons, and the difference matters to the person
 * holding the phone:
 *
 *   drm  — the video is encrypted (Widevine / FairPlay / PlayReady) and
 *          only decrypts inside a licensed player. Nothing this scanner
 *          returns will ever play on a TV. Scanning them is not merely
 *          empty either: Netflix's page carries a marketing trailer mp4,
 *          so an unguarded scan hands back a 30-second promo clip that
 *          looks like the film. A wrong answer, not a missing one.
 *
 *   app  — not encrypted, but the service ships its own cast receiver and
 *          its own app already does this better. Sending them here would
 *          be a worse version of a button they already have.
 * ------------------------------------------------------------------ */
const WALLED = [
  // --- DRM: encrypted, no browser-side path exists ---
  { host: /(^|\.)netflix\.com$/i,        why: 'drm', name: 'Netflix' },
  { host: /(^|\.)disneyplus\.com$/i,     why: 'drm', name: 'Disney+' },
  { host: /(^|\.)hotstar\.com$/i,        why: 'drm', name: 'Disney+ Hotstar' },
  { host: /(^|\.)primevideo\.com$/i,     why: 'drm', name: 'Prime Video' },
  { host: /(^|\.)hulu\.com$/i,           why: 'drm', name: 'Hulu' },
  { host: /(^|\.)(hbo)?max\.com$/i,      why: 'drm', name: 'Max' },
  { host: /(^|\.)paramountplus\.com$/i,  why: 'drm', name: 'Paramount+' },
  { host: /(^|\.)peacocktv\.com$/i,      why: 'drm', name: 'Peacock' },
  { host: /(^|\.)crunchyroll\.com$/i,    why: 'drm', name: 'Crunchyroll' },
  { host: /(^|\.)tv\.apple\.com$/i,     why: 'drm', name: 'Apple TV+' },
  { host: /(^|\.)open\.spotify\.com$/i, why: 'drm', name: 'Spotify' },
  { host: /(^|\.)mubi\.com$/i,           why: 'drm', name: 'MUBI' },
  { host: /(^|\.)viu\.com$/i,            why: 'drm', name: 'Viu' },
  { host: /(^|\.)iq\.com$/i,             why: 'drm', name: 'iQIYI' },
  { host: /(^|\.)wetv\.vip$/i,           why: 'drm', name: 'WeTV' },
  { host: /(^|\.)sooka\.my$/i,           why: 'drm', name: 'sooka' },
  { host: /(^|\.)astrogo\.astro\.com\.my$/i, why: 'drm', name: 'Astro GO' },
  // --- App-owned: works, but their own cast button is the right one ---
  { host: /(^|\.)youtube\.com$/i,        why: 'app', name: 'YouTube' },
  { host: /(^|\.)youtu\.be$/i,           why: 'app', name: 'YouTube' }
];

function walledService(urlStr) {
  let host;
  try { host = new URL(urlStr).hostname; } catch (e) { return null; }
  // amazon.co.uk/gp/video/..., amazon.com/dp/... — Prime Video off the retail domain
  if (/(^|\.)amazon\.[a-z.]+$/i.test(host) && /\/(gp\/video|Amazon-Video)\//i.test(urlStr)) {
    return { why: 'drm', name: 'Prime Video' };
  }
  const hit = WALLED.find((s) => s.host.test(host));
  return hit ? { why: hit.why, name: hit.name } : null;
}

function walledMessage(hit) {
  if (hit.why === 'app') {
    return hit.name + ' has its own cast button. Open ' + hit.name +
      ', start the video there and tap cast — it talks to the TV directly, ' +
      'and it will look better than anything routed through here.';
  }
  return hit.name + ' encrypts its video with DRM. It only decrypts inside ' +
    'a licensed player, so there is no link on that page a TV can play — ' +
    'not through this app, and not through any other. Use the ' + hit.name +
    ' app on the TV, or cast from within it.';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'Use GET.' }));
    return;
  }

  const raw = (req.query && req.query.url) ||
    new URL(req.url, 'http://localhost').searchParams.get('url');

  if (!raw) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'No address given.' }));
    return;
  }

  let target = String(raw).trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  /* Answer walled services before spending a fetch on them. */
  const walled = walledService(target);
  if (walled) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false,
      walled: walled.why,
      service: walled.name,
      error: walledMessage(walled)
    }));
    return;
  }

  try {
    const { res: pageRes, url: finalUrl } = await safeFetch(target);

    if (!pageRes.ok) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: false,
        error: 'That page answered ' + pageRes.status + '. It may need a login, or it may be gone.'
      }));
      return;
    }

    const type = (pageRes.headers.get('content-type') || '').toLowerCase();

    /* The address was the media itself — hand it straight back. */
    if (!type.includes('html') && (type.startsWith('video/') || type.startsWith('audio/') ||
        type.includes('mpegurl') || type.includes('dash+xml') || MEDIA_EXT.test(finalUrl))) {
      let media = [{
        url: finalUrl,
        kind: kindOf(finalUrl),
        label: labelFor(finalUrl),
        detail: 'direct file'
      }];
      if (media[0].kind === 'HLS') {
        const variants = await expandHlsMaster(finalUrl);
        media = media.concat(variants);
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: true, finalUrl, title: labelFor(finalUrl), poster: null,
        media, direct: true
      }));
      return;
    }

    if (!type.includes('html') && !type.includes('xml') && !type.includes('text')) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: false,
        error: 'That address is a ' + (type.split(';')[0] || 'file') + ', not a page or a video.'
      }));
      return;
    }

    const html = await readCapped(pageRes);
    const parsed = extract(html, finalUrl);

    /* One master playlist gets expanded into its real quality variants. */
    const master = parsed.media.find((x) => x.kind === 'HLS');
    if (master) {
      const variants = await expandHlsMaster(master.url);
      const known = new Set(parsed.media.map((x) => x.url));
      variants.forEach((v) => {
        if (!known.has(v.url)) { parsed.media.push(v); known.add(v.url); }
      });
      parsed.media = parsed.media.slice(0, MAX_RESULTS);
    }

    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      finalUrl,
      title: parsed.title,
      poster: parsed.poster,
      media: parsed.media,
      direct: false
    }));
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false,
      error: (err && err.message) || "That page couldn't be read."
    }));
  }
};
