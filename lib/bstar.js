/* Bilibili's international site — bilibili.tv, "bstar".
 *
 * WHY THIS IS NOT lib/bilibili.js WITH ANOTHER HOSTNAME. The two are
 * different products that share a brand. Different catalogue, different
 * accounts, different API host, different response shape, different CDN
 * behaviour. Nothing below is a parameter swap on the .com path, and an
 * attempt to share code between them would be a file full of branches.
 *
 * WHAT IS REACHABLE. Measured from this app's hosts, 2026-09-12:
 *
 *   www.bilibili.tv/en/play/<season>/<ep>        200   ← .com answers 412
 *   /intl/gateway/web/v2/ogv/play/episodes       200   ← the episode list
 *   /intl/gateway/v2/ogv/view/app/season         200   ← the title
 *   /intl/gateway/web/playurl                    200   ← the addresses
 *   upos-bstar1-mirrorakam.akamaized.net         206   see below
 *
 * The page being readable at all is the reason this is worth doing: the .com
 * path exists in the shape it does because bilibili.com answers 412 to a
 * datacentre.
 *
 * THE CDN'S REFERER RULE IS NOT "NO CHECK". Measured against one audio
 * segment, same second, same address:
 *
 *   no referer header at all                     206
 *   referer https://www.bilibili.tv/             206
 *   referer http://127.0.0.1:8099/               403
 *
 * So it permits an ABSENT referer and its own, and refuses a foreign one.
 * That distinction decides the whole design. curl sends no referer and gets
 * its bytes, which makes the CDN look open; a Cast receiver is a web page
 * and sends its own origin, which is exactly the refused case. Shaka Player
 * — which is what a Chromecast receiver runs — parsed a manifest pointing
 * straight at the CDN and then took a 403 on the first segment.
 *
 * Hence the BaseURLs below go through /api/stream, which forwards the
 * referer the CDN expects. The manifest itself is served by this app and
 * needs no such hop.
 *
 * THE ACTUAL DIFFICULTY IS THE SHAPE, NOT THE ACCESS. bstar serves DASH and
 * only DASH. Probed on platform=web, android, ios, and with type=mp4,
 * fnval=0 and fnval=1: every one returns `video[]` and `audio_resource[]` as
 * separate .m4s files and none returns the progressive `durl` that the .com
 * path relies on. So there is no single address to hand a television, and
 * casting the video file alone is a film with no sound.
 *
 * What makes it solvable is that the response carries everything an MPD
 * needs — `segment_base.range` is the initialisation segment, `index_range`
 * is the sidx, and codecs, bandwidth, mime type and frame rate are all
 * given. So this builds the manifest rather than looking for one. Because
 * the manifest is ours, its BaseURLs are absolute, which is what keeps it
 * clear of the limitation named at the top of api/stream.js: a relayed .mpd
 * is not rewritten there, and one built here needs no rewriting.
 *
 * QUALITY IS THE SIGN-IN. Anonymous gets q=32 and below — 480p. The 720p,
 * 1080p and 4K entries come back present but with `url:""`, which is the
 * gate rather than an error. This is why bilibili.tv cookies had to become
 * a real thing this app stores rather than a paste it refuses.
 */

const crypto = require('crypto');
const auth = require('./auth');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REFERER = 'https://www.bilibili.tv/';
const API = 'https://api.bilibili.tv/intl/gateway';

const TIMEOUT_MS = 10000;

/* The manifest is fetched by a television minutes after the link was
   resolved, so the token that authorises it outlives the tab. Long enough
   to start a film, short enough that a leaked URL is not a standing key. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

const QUALITY_NAMES = {
  112: '1080p60', 80: '1080p', 64: '720p', 32: '480p', 16: '360p', 6: '240p', 5: '144p'
};

/* This deploy's own address, as the television will have to reach it.
 *
 * Both the manifest URL and the segment URLs inside it are absolute, so
 * getting this wrong is a cast that fails on the television and nowhere
 * else. Vercel always sets x-forwarded-proto; the socket is the fallback,
 * because assuming https off-platform makes a local dev server hand out
 * addresses to a port that is not listening for TLS.
 */
function originOf(req) {
  const fwd = req.headers['x-forwarded-proto'];
  const proto = fwd
    ? String(fwd).split(',')[0].trim()
    : ((req.socket && req.socket.encrypted) ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return proto + '://' + host;
}

function isBstarHost(host) {
  return /(^|\.)bilibili\.tv$/i.test(String(host || ''));
}

/* bilibili.tv/en/play/<season>/<episode>, and the season-only form that the
 * site itself links to from its home page. The locale segment is part of
 * every path and carries no meaning here, so it is matched and discarded
 * rather than required to be "en". */
function parseTarget(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return null; }
  if (!isBstarHost(u.hostname)) return null;

  const m = /^\/(?:[a-z]{2}(?:[-_][a-zA-Z]{2,4})?\/)?play\/(\d+)(?:\/(\d+))?/.exec(u.pathname);
  if (!m) return null;
  return { seasonId: m[1], epId: m[2] || null };
}

async function get(url, cookie) {
  const headers = {
    'user-agent': UA,
    referer: REFERER,
    accept: 'application/json, text/plain, */*'
  };
  if (cookie) headers.cookie = cookie;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    return { status: res.status, body: body };
  } catch (e) {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * The manifest token.
 *
 * A television carries no session and cannot be given one, so the address
 * handed to it has to authorise itself. This signs the one statement the
 * manifest endpoint needs — this episode, at this quality, until this
 * moment — with the deploy's own secret.
 * ------------------------------------------------------------------ */

function signToken(body) {
  const s = auth.secret();
  if (!s) return null;
  return crypto.createHmac('sha256', s).update('bstar|' + body).digest('base64url');
}

/* ttlMs is a seam for the proof suite, which otherwise cannot produce a
   validly-signed expired token — editing the timestamp on a real one breaks
   the signature, so the signature check rejects it and the expiry check is
   never reached. A test that cannot reach the line it names is not testing
   it. Callers pass nothing. */
function issueToken(epId, qn, sealedJar, ttlMs) {
  const ttl = typeof ttlMs === 'number' ? ttlMs : TOKEN_TTL_MS;
  const body = ['b1', Date.now() + ttl, epId, qn, sealedJar || ''].join('.');
  const sig = signToken(body);
  return sig ? body + '.' + sig : null;
}

/* The episode and quality the token vouches for, or null. Verified before
   anything is fetched, so a forged token cannot cost an upstream call. */
function readToken(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;

  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const parts = body.split('.');
  if (parts.length !== 5 || parts[0] !== 'b1') return null;
  const [, exp, epId, qn, sealed] = parts;
  if (!/^\d+$/.test(exp) || !/^\d+$/.test(epId) || !/^\d+$/.test(qn)) return null;

  const expected = signToken(body);
  if (!expected) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  if (Number(exp) <= Date.now()) return null;
  return { epId: epId, qn: Number(qn), sealed: sealed || null };
}

/* ------------------------------------------------------------------ *
 * The manifest.
 * ------------------------------------------------------------------ */

function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* A duration in milliseconds as an ISO-8601 period. Three decimal places
   because that is the precision the API gives and rounding a film to the
   second puts the manifest's length a frame away from the media's. */
function isoDuration(ms) {
  return 'PT' + (Math.max(0, Number(ms) || 0) / 1000).toFixed(3) + 'S';
}

/* /api/stream, built the way api/stream's own `proxied` builds it. Absolute,
   because a relative BaseURL in a manifest fetched by a television resolves
   against the television. */
function proxied(origin, absUrl) {
  return String(origin || '').replace(/\/+$/, '') +
    '/api/stream?u=' + encodeURIComponent(absUrl) +
    '&r=' + encodeURIComponent(REFERER);
}

function representation(id, r, extra, origin) {
  const base = proxied(origin, r.url);
  const sb = r.segment_base || {};
  return [
    '      <Representation id="' + id + '" codecs="' + xml(r.codecs || '') + '"' +
      ' bandwidth="' + (Number(r.bandwidth) || 0) + '"' + (extra || '') + '>',
    extra && extra.indexOf('width=') !== -1 ? null :
      '        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>',
    '        <BaseURL>' + xml(base) + '</BaseURL>',
    '        <SegmentBase indexRange="' + xml(sb.index_range || '') + '">',
    '          <Initialization range="' + xml(sb.range || '') + '"/>',
    '        </SegmentBase>',
    '      </Representation>'
  ].filter(Boolean).join('\n');
}

/* One video rendition and one audio rendition, rather than every rendition
 * the response holds.
 *
 * A multi-Representation AdaptationSet would let the receiver switch, but
 * the receiver is a television on the far side of a cast and the qualities
 * it could switch to are exactly the ones the account has not unlocked —
 * their URLs are empty strings. An AdaptationSet holding a Representation
 * with no BaseURL is a manifest that fails on whichever rendition it picks
 * first, intermittently. Picking here is the honest form.
 */
function buildManifest(playurl, wantQn, origin) {
  const vids = (playurl.video || [])
    .map((e) => e.video_resource || e)
    .filter((r) => r && r.url && r.segment_base);
  const auds = (playurl.audio_resource || [])
    .filter((r) => r && r.url && r.segment_base);

  if (!vids.length || !auds.length) return null;

  /* The best playable rendition at or below what was asked for; if the ask
     is below everything on offer, the smallest. avc over hevc at the same
     quality — a Chromecast generation that cannot decode hev1 shows a black
     screen rather than refusing, which is the worst failure to debug. */
  const ranked = vids.slice().sort((a, b) => (b.quality - a.quality) ||
    (/^avc/i.test(a.codecs || '') ? -1 : 1));
  const video = ranked.find((r) => r.quality <= wantQn && /^avc/i.test(r.codecs || '')) ||
    ranked.find((r) => r.quality <= wantQn) ||
    ranked[ranked.length - 1];

  const audio = auds.slice().sort((a, b) => b.quality - a.quality)[0];

  const vExtra = ' width="' + (Number(video.width) || 0) + '"' +
    ' height="' + (Number(video.height) || 0) + '"' +
    (video.frame_rate ? ' frameRate="' + xml(video.frame_rate) + '"' : '') +
    (video.sar ? ' sar="' + xml(video.sar) + '"' : '');

  const dur = isoDuration(playurl.duration);

  const doc = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"',
    '     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"',
    '     type="static" mediaPresentationDuration="' + dur + '" minBufferTime="PT2S">',
    '  <Period duration="' + dur + '">',
    '    <AdaptationSet contentType="video" mimeType="' + xml(video.mime_type || 'video/mp4') +
      '" segmentAlignment="true" startWithSAP="1">',
    representation('v', video, vExtra, origin),
    '    </AdaptationSet>',
    '    <AdaptationSet contentType="audio" mimeType="' + xml(audio.mime_type || 'audio/mp4') +
      '" lang="und" segmentAlignment="true" startWithSAP="1">',
    representation('a', audio, '', origin),
    '    </AdaptationSet>',
    '  </Period>',
    '</MPD>',
    ''
  ].join('\n');

  return { xml: doc, quality: video.quality, bytes: Number(video.size || 0) + Number(audio.size || 0) };
}

/* ------------------------------------------------------------------ *
 * Resolving.
 * ------------------------------------------------------------------ */

async function playurl(epId, qn, cookie) {
  const res = await get(API + '/web/playurl' +
    '?s_locale=en_US&platform=web&ep_id=' + encodeURIComponent(epId) +
    '&qn=' + encodeURIComponent(qn) + '&device=wap&tf=0&type=0', cookie);
  if (!res.body || res.body.code !== 0 || !res.body.data || !res.body.data.playurl) {
    return { error: res.body && res.body.message && res.body.code !== -404
      ? 'Bilibili TV said: ' + res.body.message
      : null, code: res.body ? res.body.code : null };
  }
  return { playurl: res.body.data.playurl };
}

async function episodes(seasonId) {
  const res = await get(API + '/web/v2/ogv/play/episodes' +
    '?s_locale=en_US&platform=web&season_id=' + encodeURIComponent(seasonId));
  if (!res.body || res.body.code !== 0 || !res.body.data) return [];
  const out = [];
  for (const sec of (res.body.data.sections || [])) {
    for (const ep of (sec.episodes || [])) {
      if (ep && ep.episode_id) {
        out.push({
          id: String(ep.episode_id),
          title: ep.long_title_display || ep.short_title_display || ('Episode ' + ep.episode_id)
        });
      }
    }
  }
  return out;
}

async function seasonTitle(seasonId) {
  const res = await get(API + '/v2/ogv/view/app/season' +
    '?s_locale=en_US&platform=android&season_id=' + encodeURIComponent(seasonId));
  const r = res.body && res.body.result;
  return (r && r.title) ? String(r.title) : null;
}

/* The same answer shape lib/bilibili's resolve returns, so api/extract can
   treat the two as one case. `origin` is needed because the address handed
   to the television has to be absolute — a relative one resolves against
   the receiver, which is not this app. */
async function resolve(urlStr, cookie, origin) {
  const target = parseTarget(urlStr);
  if (!target) return null;

  if (!auth.secret()) {
    return { ok: false, error: 'This deploy has no signing secret, so it cannot ' +
      'authorise a manifest for the television. Set CAST_PASSWORD and redeploy.' };
  }

  let epId = target.epId;
  let epTitle = null;
  const list = await episodes(target.seasonId);

  if (!epId) {
    if (!list.length) {
      return { ok: false, error: 'Bilibili TV would not list anything under that link.' };
    }
    epId = list[0].id;
    epTitle = list.length > 1 ? list[0].title : null;
  } else {
    const found = list.find((e) => e.id === String(epId));
    if (found && list.length > 1) epTitle = found.title;
  }

  /* Ask for 1080p. Without a signed-in cookie the entries above 480p come
     back with empty URLs, and asking costs nothing when it is refused. */
  const play = await playurl(epId, 80, cookie);
  if (!play.playurl) {
    if (play.code === -404) {
      return {
        ok: false,
        error: cookie
          ? 'Bilibili TV will not serve that one to this account — it is likely ' +
            'region-locked. Its catalogue differs by country.'
          : 'Bilibili TV will not serve that one to a signed-out request. Sign in ' +
            'to bilibili.tv below and try again.'
      };
    }
    return { ok: false, error: play.error || 'Bilibili TV would not give an address for it.' };
  }

  const built = buildManifest(play.playurl, 80, origin);
  if (!built) {
    return {
      ok: false,
      error: cookie
        ? 'Bilibili TV returned no playable rendition for that one.'
        : 'Every rendition Bilibili TV offered for that one is behind its sign-in. ' +
          'Sign in to bilibili.tv below and try again.'
    };
  }

  const token = issueToken(epId, built.quality, null);
  if (!token) return { ok: false, error: 'This deploy could not sign the manifest.' };

  const season = await seasonTitle(target.seasonId);
  const title = [season, epTitle].filter(Boolean).join(' · ') || ('Episode ' + epId);
  const quality = QUALITY_NAMES[built.quality] || ('q' + built.quality);
  const pageUrl = 'https://www.bilibili.tv/en/play/' + target.seasonId + '/' + epId;

  return {
    ok: true,
    finalUrl: pageUrl,
    title: title,
    referer: REFERER,
    signedIn: Boolean(cookie),
    /* Capped is the difference between "this is what it is" and "this is
       what you are being given" — the app says so rather than letting a
       480p cast look like the ceiling of the service. */
    capped: !cookie && built.quality <= 32,
    media: [{
      url: String(origin || '').replace(/\/+$/, '') + '/api/bstar?t=' + encodeURIComponent(token),
      kind: 'DASH',
      label: title + ' · ' + quality,
      detail: 'Bilibili TV · ' + quality +
        (built.bytes ? ' · ' + Math.round(built.bytes / 1e6) + ' MB' : ''),
      bytes: built.bytes,
      seconds: Math.round((play.playurl.duration || 0) / 1000) || null,
      /* False because the address below is already this app's own, and the
         segments inside the manifest carry their own /api/stream hop. Setting
         it would send the manifest URL through the proxy a second time — and
         api/stream relays an .mpd without rewriting it, which is the note at
         the top of that file. */
      viaProxy: false
    }]
  };
}


/* Is this jar worth keeping?
 *
 * The .com path answers this with /x/web-interface/nav, which names the
 * account. bstar publishes no equivalent — /web/user/info, /v2/user/info,
 * /web/myinfo, /account/web/nav and /web/space/account are all 404, and
 * /web/v2/user/space answers -400 to every shape tried. So there is no
 * endpoint here that will say who you are.
 *
 * What there is, is the thing the sign-in is actually FOR. Anonymous, every
 * rendition above 480p comes back present with `url:""`; signed in, those
 * URLs are populated. Asking a real episode for 1080p and looking at whether
 * anything above 480p has an address tests the capability rather than the
 * credential, which is the more useful answer of the two — a session that
 * authenticates but unlocks nothing would pass a nav check and still leave
 * the cast at 480p.
 *
 * Returns 'hd' when it unlocked something, 'basic' when the session works
 * but nothing above 480p came back, and null when the reference could not be
 * reached at all — which is not the same as a bad paste and is not reported
 * as one.
 */
async function verifyJar(cookie, seasonId) {
  const season = seasonId || process.env.BSTAR_REFERENCE_SEASON || '2117053';
  const list = await episodes(season);
  if (!list.length) return null;

  const play = await playurl(list[0].id, 80, cookie);
  if (!play.playurl) return null;

  const unlocked = (play.playurl.video || [])
    .map((e) => e.video_resource || e)
    .filter((r) => r && r.url && r.quality > 32);

  return unlocked.length ? 'hd' : 'basic';
}

module.exports = {
  isBstarHost, originOf, parseTarget, verifyJar, resolve, episodes, seasonTitle,
  playurl, buildManifest, issueToken, readToken, REFERER, QUALITY_NAMES
};

/* ------------------------------------------------------------------ *
 * The bilibili.tv jar.
 *
 * SEPARATE STORAGE, NOT A SHARED ONE. bilibili.com and bilibili.tv are
 * separate sign-ins, and a cookie from either authenticates nothing at the
 * other — measured against /x/web-interface/nav, a .tv jar and no jar at all
 * gave byte-identical signed-out answers. So this is its own cookie with its
 * own seal namespace. Someone signed in to both keeps both, and neither can
 * silently stand in for the other, which is the failure that made a .tv
 * paste look accepted and then fail at resolve time.
 *
 * The seal is the same construction lib/bilibili uses — HMAC over the deploy
 * secret, no database — for the reason given there. The namespace differs so
 * a jar sealed for one site cannot be replayed as the other's.
 * ------------------------------------------------------------------ */

const JAR_COOKIE = 'cb_bstar';
const JAR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP = ['SESSDATA', 'bili_jct', 'DedeUserID'];

function jarSign(body) {
  const s = auth.secret();
  if (!s) return null;
  return crypto.createHmac('sha256', s).update('bstar-jar|' + body).digest('base64url');
}

function sealJar(jar) {
  const kept = {};
  KEEP.forEach((k) => { if (jar && jar[k]) kept[k] = String(jar[k]); });
  if (!kept.SESSDATA) return null;
  const body = Buffer.from(JSON.stringify({
    j: kept, exp: Date.now() + JAR_TTL_MS
  })).toString('base64url');
  const sig = jarSign(body);
  return sig ? body + '.' + sig : null;
}

function unsealJar(token) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = jarSign(body);
  if (!expected) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!parsed || !parsed.j || !parsed.j.SESSDATA) return null;
  if (!parsed.exp || parsed.exp <= Date.now()) return null;
  return parsed.j;
}

function cookieHeader(jar) {
  if (!jar) return '';
  return KEEP.filter((k) => jar[k]).map((k) => k + '=' + jar[k]).join('; ');
}

function netscapeLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const bare = line.replace(/^#HttpOnly_/, '');
    if (bare === line && line[0] === '#') continue;
    const f = bare.split('\t');
    if (f.length < 7) continue;
    out.push({ domain: f[0].trim().toLowerCase(), name: f[5].trim(), value: f[6].trim() });
  }
  return out;
}

/* Scoped to bilibili.tv on purpose, and the mirror image of the .com
 * parser's scoping. A whole-browser export from someone signed in to both
 * holds two SESSDATA values, and taking whichever appeared first would put
 * the .com session behind the .tv resolver — which authenticates nothing and
 * looks like a broken account rather than a mixed-up one. */
function parseCookieText(text) {
  if (!text || typeof text !== 'string' || text.length > 262144) return null;

  const jar = {};
  const rows = netscapeLines(text);

  for (const row of rows) {
    if (row.domain.indexOf('bilibili.tv') === -1) continue;
    if (KEEP.indexOf(row.name) === -1 || !row.value) continue;
    jar[row.name] = row.value;
  }

  /* A loose paste — a document.cookie dump or a header copied out of the
     network tab — carries no domains at all. It is taken at its word only
     when nothing in the text claims to be from bilibili.com, because a file
     that names the other site and no .tv rows is a wrong-site paste, and
     diagnose() has a better sentence for it than this has a value. */
  if (!jar.SESSDATA && !rows.some((r) => r.domain.indexOf('bilibili.com') !== -1)) {
    for (const name of KEEP) {
      const re = new RegExp('(?:^|[;,\\s])' + name + '\\s*[=:]\\s*"?([^;,"\\s]+)', 'i');
      const m = re.exec(text);
      if (m) jar[name] = m[1];
    }

    if (!jar.SESSDATA) {
      const bare = text.trim();
      if (/^[A-Za-z0-9%_\-*.]+$/.test(bare) &&
          bare.length >= 24 && bare.length <= 512 &&
          (bare.match(/%2C/gi) || []).length >= 2) {
        jar.SESSDATA = bare;
      }
    }
  }

  return jar.SESSDATA ? jar : null;
}

/* Why a paste was refused. The mirror of lib/bilibili's, and the case it
   names most often is the one that used to be the only advice this app
   gave: an export from the other Bilibili. */
function diagnoseCookieText(text) {
  if (!text || typeof text !== 'string') return null;
  if (parseCookieText(text)) return null;
  const rows = netscapeLines(text);
  if (!rows.length) return null;

  const tv = rows.some((r) => r.domain.indexOf('bilibili.tv') !== -1);
  const com = rows.some((r) => r.domain.indexOf('bilibili.com') !== -1);

  if (com && !tv) {
    return 'That export is from bilibili.com. It is the mainland site and a ' +
      'separate sign-in from bilibili.tv, so its cookies will not work here. ' +
      'Open bilibili.tv, sign in there, and export again.';
  }
  if (tv) {
    return 'That export is from bilibili.tv but carries no SESSDATA. Either the ' +
      'browser was signed out when it was made, or the extension skipped ' +
      'HttpOnly cookies, and SESSDATA is one. Sign in, check your name shows on ' +
      'the page, then export again.';
  }
  return null;
}

function jarFromRequest(req) {
  return cookieHeader(unsealJar(auth.readCookie(req, JAR_COOKIE)));
}

function setJarHeader(jar) {
  const sealed = sealJar(jar);
  if (!sealed) return null;
  const bits = [
    JAR_COOKIE + '=' + encodeURIComponent(sealed),
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + Math.floor(JAR_TTL_MS / 1000)
  ];
  if (!process.env.CAST_INSECURE_COOKIE) bits.splice(3, 0, 'Secure');
  return bits.join('; ');
}

function clearJarHeader() {
  const secure = process.env.CAST_INSECURE_COOKIE ? '' : ' Secure;';
  return JAR_COOKIE + '=; Path=/; HttpOnly;' + secure + ' SameSite=Lax; Max-Age=0';
}

module.exports.JAR_COOKIE = JAR_COOKIE;
module.exports.KEEP = KEEP;
module.exports.sealJar = sealJar;
module.exports.unsealJar = unsealJar;
module.exports.cookieHeader = cookieHeader;
module.exports.parseCookieText = parseCookieText;
module.exports.diagnoseCookieText = diagnoseCookieText;
module.exports.jarFromRequest = jarFromRequest;
module.exports.setJarHeader = setJarHeader;
module.exports.clearJarHeader = clearJarHeader;
