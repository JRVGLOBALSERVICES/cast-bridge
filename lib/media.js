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

/* One list, because it had been written out four times and they had already
   drifted: `.ogv` was in none of them, so an Ogg video on an ordinary page
   was invisible to a scanner that had no trouble with the .webm beside it. */
const MEDIA_EXT_LIST = 'm3u8|mpd|mp4|m4v|webm|mkv|mov|ogv|mp3|m4a|aac|ogg|opus|flac|wav';

const MEDIA_EXT = new RegExp('\\.(' + MEDIA_EXT_LIST + ')(\\?[^"\'\\s\\\\<>]*)?$', 'i');

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
async function safeFetch(startUrl, accept, opts) {
  const o = opts || {};
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs || FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: Object.assign({
          'user-agent': UA,
          accept: accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9'
        }, o.headers || {})
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
  if (k === 'WEBM' || k === 'MOV' || k === 'MKV' || k === 'OGV') return 3;
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
    if (!MEDIA_EXT.test(seg)) return;
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

  /* Player quality lists — `sources:[{file:"…",label:"720p"},…]`.

     Read before the loose sweep below, and only because of the order: the
     sweep finds the same three addresses and names each one after the file
     at the end of its path. These hosts serve every quality as `/…/v.mp4`,
     so without the label the person holding the phone is offered three
     identical choices and a 192p guess. */
  const sourcesRe =
    /["']?(?:sources|playlist|qualities|levels)["']?\s*[:=]\s*\[([\s\S]{0,20000}?)\]/gi;
  while ((m = sourcesRe.exec(html))) {
    const objRe = /\{([^{}]*)\}/g;
    let o;
    while ((o = objRe.exec(m[1]))) {
      const body = o[1];
      const file =
        (/["']?(?:file|src|url|source)["']?\s*:\s*["']([^"']+)["']/i.exec(body) || [])[1];
      if (!file) continue;
      let label =
        (/["']?(?:label|quality|res(?:olution)?|height)["']?\s*:\s*["']?([^"',}\s]+)/i
          .exec(body) || [])[1];
      if (label) {
        label = label.trim().slice(0, 24);
        if (/^\d+$/.test(label)) label += 'p';
      }
      add(file, 'player quality', label || null);
    }
  }

  /* Anything file-shaped anywhere in the markup or its inline scripts.
     Player configs live in inline JSON far more often than in attributes. */
  const loose = new RegExp(
    'https?:\\\\?\\/\\\\?\\/[^\\s"\'<>\\\\)]+?\\.(?:' + MEDIA_EXT_LIST +
    ')(?:\\?[^\\s"\'<>\\\\)]*)?', 'gi');
  while ((m = loose.exec(html))) add(m[0], 'page source');

  /* Relative playlist paths, e.g. src: "/hls/master.m3u8" */
  const rel = new RegExp(
    '["\'](\\/[^"\'\\s<>]+?\\.(?:' + MEDIA_EXT_LIST + ')(?:\\?[^"\'\\s<>]*)?)["\']', 'gi');
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
 * Packed player scripts
 *
 * Almost every free embed host ships its player config through Dean
 * Edwards' packer — `eval(function(p,a,c,k,e,d){...}('...',62,84,'...'.
 * split('|'),0,{}))`. The address is still handed to the browser in
 * plain sight, but the packer has split every word of it into a
 * dictionary, so `sys.vkcdn5.com/…/v.mp4` exists in the delivered bytes
 * only as the separate tokens `sys`, `vkcdn5`, `com`, `mp4`. No pattern
 * over the HTML can put them back together, which is why a page with
 * three ordinary mp4 files on it came back as "no video link is written
 * into that page".
 *
 * This is not a protection being undone. The packer is a 2000s-era
 * minifier — it carries its own dictionary and its own decoder in the
 * page, because the browser has to be able to read it. Reversing it
 * recovers the same text the browser gets.
 *
 * Unpacked by substitution, never by running it. The payload is a
 * stranger's JavaScript and this runs on our server, so eval() would
 * hand every page we scan the ability to execute code here. The packer's
 * decode is a base-N dictionary lookup and nothing more, so performing
 * it by hand costs one loop and carries none of that.
 * ------------------------------------------------------------------ */

/* The packer's own digit set: base 36 is 0-9a-z, base 62 continues into
   A-Z (its encoder reaches those through String.fromCharCode(c + 29)). */
const PACKER_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const MAX_UNPACK_ROUNDS = 3;
const MAX_UNPACK_BLOCKS = 6;
const MAX_UNPACKED_BYTES = 512 * 1024;

/* Where the packed call's arguments begin. Anchoring on the signature
   rather than on the argument shape alone keeps this from firing on an
   unrelated function call that happens to end in a .split('|'). */
const PACKER_SIGNATURE = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,/g;

/* '<payload>', <radix>, <count>, '<dictionary>'.split('|')
   The two string literals are read with their escapes intact and undone
   afterwards, so a quote inside the payload cannot end it early. */
const PACKER_ARGS =
  /\}\s*\(\s*(['"])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\[\s\S]|(?!\5)[\s\S])*?)\5\s*\.\s*split\s*\(\s*(['"])\|\7\s*\)/;

function packerIndex(token, radix) {
  let n = 0;
  for (let i = 0; i < token.length; i++) {
    const d = PACKER_DIGITS.indexOf(token[i]);
    /* A digit the radix does not reach is not a dictionary reference —
       it is an ordinary word that survived packing. Leave it alone. */
    if (d < 0 || d >= radix) return -1;
    n = n * radix + d;
  }
  return n;
}

/* Undo a JavaScript string literal's escapes. */
function unescapeJsString(s) {
  return String(s).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (whole, esc) => {
      if (esc[0] === 'u') {
        const hex = esc[1] === '{' ? esc.slice(2, -1) : esc.slice(1);
        const code = parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      if (esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
      const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
      return Object.prototype.hasOwnProperty.call(simple, esc) ? simple[esc] : esc;
    });
}

/* Every packed block in one document, unpacked, as one string. Returns
   '' when there is nothing packed — the overwhelmingly common case, and
   the one that must stay cheap. */
function unpackOnce(text) {
  if (!text || text.indexOf('p,a,c,k,e') === -1) return '';

  const out = [];
  let total = 0;
  let blocks = 0;
  PACKER_SIGNATURE.lastIndex = 0;

  let sig;
  while ((sig = PACKER_SIGNATURE.exec(text)) && blocks < MAX_UNPACK_BLOCKS) {
    /* The arguments follow the function body. Search a bounded window so
       a malformed block cannot drag the scan across the whole document. */
    const window = text.slice(sig.index, sig.index + MAX_UNPACKED_BYTES);
    const args = PACKER_ARGS.exec(window);
    if (!args) continue;

    const radix = parseInt(args[3], 10);
    if (!(radix >= 2 && radix <= PACKER_DIGITS.length)) continue;

    const payload = unescapeJsString(args[2]);
    const dict = unescapeJsString(args[6]).split('|');

    const decoded = payload.replace(/\b\w+\b/g, (token) => {
      const i = packerIndex(token, radix);
      return (i >= 0 && i < dict.length && dict[i]) ? dict[i] : token;
    });

    blocks += 1;
    total += decoded.length;
    out.push(decoded);
    if (total >= MAX_UNPACKED_BYTES) break;

    /* Resume past the block just read rather than inside it. */
    PACKER_SIGNATURE.lastIndex = sig.index + args.index + args[0].length;
  }

  return out.join('\n');
}

/* A document with its packed scripts appended in the clear.
 *
 * Appended, not substituted: everything the page said in plain text is
 * still true, and the parsers downstream read a flat blob rather than a
 * DOM, so more text can only add findings. A packer inside a packer is
 * ordinary on these hosts, hence the rounds. */
function deobfuscate(html) {
  if (!html) return html;
  let added = '';
  let round = 0;
  let source = html;

  while (round < MAX_UNPACK_ROUNDS) {
    const next = unpackOnce(source);
    if (!next) break;
    added += '\n' + next;
    if (added.length >= MAX_UNPACKED_BYTES) break;
    source = next;
    round += 1;
  }

  return added ? html + '\n<!-- unpacked -->\n' + added : html;
}

/* ------------------------------------------------------------------ *
 * Widening the quick scan
 *
 * Three ordinary shapes the fetch-and-parse pass used to walk straight
 * past. None of them undo anything a site protects — each one is a plain
 * address the page gives out freely, just not in the single place the
 * first pass looked:
 *
 *   frames      — the post is a wrapper and the player lives one hop away
 *                 in an <iframe>. Very common on blogs and aggregators.
 *   candidates  — the address is in the player config but its name gives
 *                 nothing away (`/hls/48213/index`, `/manifest?t=...`).
 *                 Signed CDN links almost never carry an extension.
 *   share links — Drive and Dropbox name the file in the path, and the
 *                 address that serves its bytes is a fixed rewrite of it.
 *
 * A candidate is never reported on its name. It is fetched, and only the
 * first few kilobytes of the answer decide: the content type, or the
 * manifest and container magic at the front of the body.
 * ------------------------------------------------------------------ */

const MAX_FRAMES = 3;
const MAX_CANDIDATES = 8;
const MAX_PROBES = 5;
const FRAME_TIMEOUT_MS = 7000;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_BYTES = 4096;

/* Frames and URLs that are never a player, so following them only spends
   budget. Shared with the deep scan so both passes agree. */
const NOT_A_PLAYER =
  /googletagmanager|google-analytics|googlesyndication|doubleclick|adservice|adsystem|adnxs|taboola|outbrain|facebook\.com|connect\.facebook|platform\.twitter|recaptcha|hcaptcha|disqus|intercom|hotjar|cloudflareinsights|onesignal/i;

/* What a page says when it has recognised the scanner and refused, rather
   than when it has nothing to give.

   This distinction is the whole point. Measured on movieshub.rpmplay.xyz
   (the embed behind desicinema.org): its play handler runs a headless check
   and replaces the page with "Opss! Headless Browser is not allowed". No
   manifest is ever requested, so every downstream signal looks exactly like
   an empty page — and the scan used to answer "the player never fetched
   anything playable, it probably needs a sign-in, or it is encrypted". That
   answer was wrong, and being wrong sent us looking for a cipher that was
   never the obstacle. A refusal we can read is a refusal we must report.

   Deliberately narrow. A phrase here overrides the ordinary "nothing found"
   answer, so a loose pattern would relabel genuinely empty pages as walls
   and put us right back to guessing. Every entry names automation or a
   human-check explicitly; nothing matches on "denied" or "forbidden" alone,
   which ordinary pages say for ordinary reasons. */
const BOT_WALL = [
  /headless\s+browser\s+(?:is\s+)?not\s+allowed/i,
  /headless\s+(?:browser\s+)?detected/i,
  /automation\s+(?:tool\s+)?(?:detected|not\s+allowed)/i,
  /(?:bot|robot|crawler|scraper)s?\s+(?:are\s+)?(?:detected|not\s+allowed|not\s+permitted)/i,
  /webdriver\s+detected/i,
  /checking\s+your\s+browser\s+before/i,
  /verify\s+(?:that\s+)?you(?:'re|\s+are)\s+(?:a\s+)?human/i,
  /enable\s+javascript\s+and\s+cookies\s+to\s+continue/i
];

/* The first thing a page said that names automation, or null. Reads a
   single text blob; the caller decides which document it came from. */
function botWallPhrase(text) {
  if (!text) return null;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  for (const re of BOT_WALL) {
    const hit = flat.match(re);
    if (hit) {
      /* Hand back the sentence it sits in, not the regex's own slice — the
         phrasing is what makes the report believable, and it is the site's
         wording, not ours. */
      const start = Math.max(0, hit.index - 60);
      return flat.slice(start, Math.min(flat.length, hit.index + hit[0].length + 60)).trim();
    }
  }
  return null;
}

/* Where a lazy-loading page parks the real address until it decides to
   load. LiteSpeed Cache, WP Rocket and the rest of the caching plugins all
   do this, so it is an ordinary-web pattern, not an exotic one. */
const DEFERRED_SRC_ATTRS = [
  'data-litespeed-src', 'data-src', 'data-lazy-src', 'data-original',
  'data-url', 'data-iframe-src', 'data-lazy-iframe', 'data-embed',
  'data-player-src'
];

/* A frame path that reads like a player is worth following before one that
   reads like a comment widget. */
const EMBED_HINT = /(\/embed|\/player|\/stream|\/watch|\/e\/|\/v\/|embed\.|player\.|stream\.)/i;

/* Content types that mean "this response is playable", for the cases where
   the URL carries no useful extension. */
const MEDIA_TYPE =
  /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream))/i;

/* Extensions that settle it the other way — no need to spend a probe. */
const NOT_MEDIA_EXT =
  /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|woff2?|ttf|otf|eot|pdf|zip|txt|map)(\?|$)/i;

/* Player configs put the address behind one of a small set of names. */
const CONFIG_KEY = new RegExp(
  '["\']?(?:file|src|source|url|hls|hlsUrl|hls_url|dash|dashUrl|stream|streamUrl|' +
  'stream_url|manifest|manifestUrl|playlist|playlistUrl|video_url|videoUrl|' +
  'sourceUrl|source_url|mp4|videoSrc|media|mediaUrl)["\']?\\s*[:=]\\s*' +
  '["\']([^"\'\\s\\\\]{8,600})["\']',
  'gi'
);

/* Share links whose direct address is a documented, fixed rewrite. */
function normalizeShare(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return urlStr; }
  const host = u.hostname.toLowerCase();

  if (/(^|\.)(drive|docs)\.google\.com$/.test(host)) {
    const id = (/\/(?:file|d)\/d?\/?([-\w]{16,})/.exec(u.pathname) || [])[1] ||
      (/\/file\/d\/([-\w]{16,})/.exec(u.pathname) || [])[1] ||
      u.searchParams.get('id');
    if (id) return 'https://drive.google.com/uc?export=download&id=' + id;
  }
  if (/(^|\.)dropbox\.com$/.test(host)) {
    u.searchParams.delete('dl');
    u.searchParams.set('raw', '1');
    return u.toString();
  }
  return urlStr;
}

/* Where the page keeps its HTML comments — the spans a browser never
   renders. Script and style bodies are stepped over first, because the
   legacy `<!--` wrapper is still common inside them and a player config is
   exactly the thing that must not be thrown away with the dead markup.

   This exists because desi-serials.to leaves last week's player commented
   out above the live one. A regex over raw HTML read that corpse as the
   page's embed, and the scan then named a host that was not in play and
   sent Rj to go and check it. A frame no browser will ever load is not a
   frame. */
function commentRanges(html) {
  const skip = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const safe = [];
  let m;
  while ((m = skip.exec(html))) safe.push([m.index, m.index + m[0].length]);
  const inSafe = (i) => safe.some(([a, b]) => i >= a && i < b);

  const ranges = [];
  const re = /<!--[\s\S]*?-->/g;
  while ((m = re.exec(html))) {
    if (inSafe(m.index)) continue;
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/* Every frame on the page worth opening, player-shaped ones first. */
function collectFrames(html, baseUrl) {
  const hits = [];
  const seen = new Set();
  const base = String(baseUrl).split('#')[0];

  const push = (raw) => {
    if (!raw) return;
    if (/^(about:|javascript:|data:)/i.test(String(raw).trim())) return;
    const abs = absolute(decodeEntities(String(raw).replace(/\\\//g, '/').trim()), baseUrl);
    if (!abs) return;
    if (seen.has(abs)) return;
    if (abs.split('#')[0] === base) return;
    if (NOT_A_PLAYER.test(abs)) return;
    /* A frame whose address is an icon, a stylesheet or a script is not a
       player, and following it spends a fetch to learn nothing. Dailymotion
       parks a favicon in one, which is how this was found. */
    if (NOT_MEDIA_EXT.test(abs)) return;
    seen.add(abs);
    hits.push(abs);
  };

  const dead = commentRanges(html);
  const commentedOut = (i) => dead.some(([a, b]) => i >= a && i < b);

  const tagRe = /<(?:iframe|frame)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    if (commentedOut(m.index)) continue;
    const tag = m[0];
    push((/\ssrc\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1]);
    for (const attr of DEFERRED_SRC_ATTRS) {
      const re = new RegExp('\\s' + attr + '\\s*=\\s*["\']([^"\']+)["\']', 'i');
      push((re.exec(tag) || [])[1]);
    }
  }

  hits.sort((a, b) => (EMBED_HINT.test(b) ? 1 : 0) - (EMBED_HINT.test(a) ? 1 : 0));
  return hits.slice(0, MAX_FRAMES);
}

/* Addresses from the player config whose name proves nothing either way.
   extract() already took everything that is visibly file-shaped, so these
   are exactly the ones a name test would have thrown away. */
function collectCandidates(html, baseUrl) {
  const hits = [];
  const seen = new Set();
  const base = String(baseUrl).split('#')[0];

  const re = new RegExp(CONFIG_KEY.source, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const abs = absolute(decodeEntities(String(m[1]).replace(/\\\//g, '/').trim()), baseUrl);
    if (!abs) continue;
    if (seen.has(abs)) continue;
    if (abs.split('#')[0] === base) continue;
    if (NOT_A_PLAYER.test(abs) || NOT_MEDIA_EXT.test(abs)) continue;

    /* Already file-shaped means extract() has it. */
    const seg = abs.split('?')[0].split('/').pop() || '';
    if (MEDIA_EXT.test(seg)) continue;

    let u;
    try { u = new URL(abs); } catch (e) { continue; }
    if (u.pathname === '/' && !u.search) continue;

    seen.add(abs);
    hits.push(abs);
    if (hits.length >= MAX_CANDIDATES) break;
  }
  return hits;
}

function typeToKind(type) {
  if (/mpegurl/.test(type)) return 'HLS';
  if (/dash\+xml/.test(type)) return 'DASH';
  if (/mp4/.test(type)) return 'MP4';
  if (/webm/.test(type)) return 'WEBM';
  if (/matroska/.test(type)) return 'MKV';
  if (type.startsWith('audio/')) return 'AUDIO';
  return 'VIDEO';
}

/* Ask a candidate what it is, and believe the answer rather than the name.
   Reads at most PROBE_BYTES: enough for a content type, a manifest header
   or a container signature, and not enough to matter. */
async function probeMedia(candidate) {
  let res, finalUrl;
  try {
    const r = await safeFetch(candidate, '*/*', {
      timeoutMs: PROBE_TIMEOUT_MS,
      headers: { range: 'bytes=0-' + (PROBE_BYTES - 1) }
    });
    res = r.res;
    finalUrl = r.url;
  } catch (e) {
    return null;
  }

  const drop = () => { try { res.body && res.body.cancel(); } catch (e) { /* closed */ } };

  if (!res.ok && res.status !== 206) { drop(); return null; }

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type.includes('html')) { drop(); return null; }

  /* octet-stream is in MEDIA_TYPE because so many CDNs mislabel mp4 that
     way, but it proves nothing on its own — let the body settle those. */
  if (MEDIA_TYPE.test(type) && !/octet-stream/.test(type)) {
    drop();
    return { url: finalUrl, kind: typeToKind(type) };
  }

  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  }
  const head = buf.slice(0, 512).toString('utf8');
  if (/^\s*#EXTM3U/.test(head)) return { url: finalUrl, kind: 'HLS' };
  if (/<MPD[\s>]/i.test(head)) return { url: finalUrl, kind: 'DASH' };
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') {
    return { url: finalUrl, kind: 'MP4' };
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) {
    return { url: finalUrl, kind: 'WEBM' };
  }
  if (buf.length >= 3 && head.slice(0, 3) === 'ID3') return { url: finalUrl, kind: 'AUDIO' };
  if (buf.length >= 4 && head.slice(0, 4) === 'OggS') return { url: finalUrl, kind: 'AUDIO' };
  return null;
}

/* Probe several at once — one slow host must not spend the whole budget. */
async function probeAll(candidates, detail) {
  const list = candidates.slice(0, MAX_PROBES);
  if (!list.length) return [];
  const settled = await Promise.all(list.map((c) => probeMedia(c).catch(() => null)));
  const out = [];
  const seen = new Set();
  settled.forEach((hit) => {
    if (!hit || seen.has(hit.url)) return;
    seen.add(hit.url);
    out.push({
      url: hit.url,
      kind: hit.kind,
      label: labelFor(hit.url),
      detail: detail || 'player config'
    });
  });
  return out;
}

/* Open the frames a wrapper page delegates to, and read each the same way
   the page itself was read. One hop only: a frame inside a frame is the
   deep scan's job, and it already runs them all. */
async function readFrames(frames, parentUrl) {
  const list = frames.slice(0, MAX_FRAMES);
  if (!list.length) return { media: [], candidates: [] };

  const results = await Promise.all(list.map(async (frameUrl) => {
    try {
      const { res, url } = await safeFetch(frameUrl, null, {
        timeoutMs: FRAME_TIMEOUT_MS,
        headers: { referer: parentUrl }
      });
      if (!res.ok) { try { res.body && res.body.cancel(); } catch (e) {} return null; }
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (!type.includes('html') && !type.includes('xml') && !type.includes('text')) {
        try { res.body && res.body.cancel(); } catch (e) {}
        return null;
      }
      const html = deobfuscate(await readCapped(res));
      let host = url;
      try { host = new URL(url).hostname; } catch (e) { /* keep the url */ }
      return {
        host,
        parsed: extract(html, url),
        candidates: collectCandidates(html, url)
      };
    } catch (e) {
      return null;
    }
  }));

  const media = [];
  const candidates = [];
  results.forEach((r) => {
    if (!r) return;
    r.parsed.media.forEach((x) => {
      media.push(Object.assign({}, x, { detail: 'embedded player · ' + r.host }));
    });
    r.candidates.forEach((c) => candidates.push(c));
  });
  return { media, candidates };
}

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



/* What to say when the scan finished and the list is empty.
 *
 * Lifted out of api/scan.js so the sentence can be tested without a browser,
 * and because it was getting one case wrong in a way that sent Rj hunting
 * for a typo in a perfectly good address. The old rule read "no <video> and
 * no VISIBLE frame" as "there is no video on this page at all" — and a
 * player that a page keeps in a collapsed panel until you pick a source has
 * a zero-by-zero box, so a page that plainly carries an embed was reported
 * as carrying nothing.
 *
 * The three answers are genuinely different problems and the person holding
 * the phone can act on exactly one of them:
 *
 *   walled    -- the site recognised the scanner. Nothing to try.
 *   nothing   -- no player and no embed. Check the address.
 *   elsewhere -- there IS an embed, and it gave us nothing back. The video
 *                lives on another host, and that host is the wall.
 *   quiet     -- the player is here and never fetched anything playable.
 */
function emptyVerdict(saw) {
  saw = saw || {};
  const players = saw.players || 0;
  const frames = saw.frames || 0;
  const embeds = saw.embeds || 0;

  if (saw.botWall) {
    return {
      why: 'walled',
      error: 'That site refuses automated browsers, and said so: "' + saw.botWall +
        '". It is not a sign-in and it is not encryption — the page recognised ' +
        'the scanner and stopped before asking for the video at all. Nothing ' +
        'this app can run on a server gets past that, because the check is on ' +
        'whether a person is holding the browser.'
    };
  }

  if (!players && !frames && !embeds) {
    return {
      why: 'nothing',
      error: 'Ran the page in a browser. There is no video on it at all — no ' +
        'player, no embed, nothing to cast. Check the address is the one you ' +
        'meant to send.'
    };
  }

  if (!players && embeds) {
    const host = saw.embedHost ? ' (' + saw.embedHost + ')' : '';
    return {
      why: 'elsewhere',
      error: 'That page does not hold the video — it hands off to a player on ' +
        'another host' + host + ', and that host gave this server nothing back. ' +
        'Sites that serve their video from a second domain usually only answer ' +
        'a browser a person is holding, so the address is fine and the page is ' +
        'fine; the hand-off is where it stops. If you already have a direct ' +
        'link to the video file, paste that instead and it will cast.'
    };
  }

  return {
    why: 'quiet',
    error: 'Ran the page in a browser, opened its player and watched every ' +
      'request. The player is there but never fetched anything playable. It ' +
      'probably needs a sign-in, or it is encrypted the way the big streaming ' +
      'apps are.'
  };
}

module.exports = {
  FETCH_TIMEOUT_MS, MAX_BYTES, MAX_REDIRECTS, MAX_RESULTS, UA, MEDIA_EXT,
  isPrivateIp, assertPublic, safeFetch, readCapped,
  absolute, kindOf, rank, decodeEntities, extract, labelFor,
  expandHlsMaster, WALLED, walledService, walledMessage,
  MEDIA_EXT_LIST,
  MAX_FRAMES, MAX_CANDIDATES, MAX_PROBES, NOT_A_PLAYER, DEFERRED_SRC_ATTRS,
  MEDIA_TYPE, NOT_MEDIA_EXT, CONFIG_KEY, BOT_WALL, botWallPhrase,
  normalizeShare, collectFrames, collectCandidates, typeToKind,
  deobfuscate, unpackOnce, unescapeJsString,
  probeMedia, probeAll, readFrames, emptyVerdict, collectFrames, commentRanges
};
