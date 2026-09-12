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
const { safeFetch } = require('./media');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REFERER = 'https://www.bilibili.tv/';
const API = 'https://api.bilibili.tv/intl/gateway';

const TIMEOUT_MS = 10000;

/* The manifest is fetched by a television minutes after the link was
   resolved, so the token that authorises it outlives the tab. Long enough
   to start a film, short enough that a leaked URL is not a standing key. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

/* The relay's own window. Sixty seconds is a request in flight and nothing
   more; the signed body is not something worth replaying. */
const ALT_TTL_MS = 60 * 1000;
const ALT_PATH = '/api/bstar-alt';

/* The codes that mean "not from here", as opposed to "not at all".
 *
 * Measured 2026-09-12 across five Vercel regions against twenty series and
 * sixteen user uploads:
 *
 *   10004001  a series refused in some regions and played in others.
 *   10015001  every user upload refused, including ones that play elsewhere
 *             — the whole region is shut out of UGC. Its `message` is the
 *             only one bilibili writes in plain terms: 版权地区受限.
 *   10023013  a PARTICULAR upload refused in sin1 while sixteen of sixteen
 *             played from hkg1, hnd1 and icn1. Per-title, not per-region.
 *
 * A code in this list is worth asking the other vantage about. A code that
 * is not — 10004404 for a delisted title, -404 for an id that does not
 * exist — gives the same answer from everywhere and asking twice only
 * doubles the wait. */
const REGION_CODES = [10004001, 10015001, 10023013];

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

/* bili.im is bilibili.tv's share shortener, and it is NOT b23.tv.
 *
 * The two look interchangeable and are not: b23.tv belongs to bilibili.com
 * and lands on a BV id, bili.im belongs to bilibili.tv and lands on a
 * numeric one. Sending either to the other site's resolver produces a link
 * that "is not a video" — which was this app's answer to a share straight
 * out of the Bilibili TV app, and was never true of the link. */
function isBstarShortHost(host) {
  return /^bili\.im$/i.test(String(host || ''));
}

/* Three shapes, all of them the site's own:
 *
 *   /en/play/<season>/<episode>   a series episode, and the season-only
 *   /en/play/<season>             form the home page links to
 *   /en/video/<aid>               a USER UPLOAD, which is a different
 *                                 catalogue reached by a different API
 *                                 parameter — and the shape every film in
 *                                 a bilibili.tv playlist actually has
 *
 * The locale segment is part of every path and carries no meaning here, so
 * it is matched and discarded rather than required to be "en". */
function parseTarget(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return null; }
  if (isBstarShortHost(u.hostname)) return { short: urlStr };
  if (!isBstarHost(u.hostname)) return null;

  const loc = '^\\/(?:[a-z]{2}(?:[-_][a-zA-Z]{2,4})?\\/)?';

  const play = new RegExp(loc + 'play\\/(\\d+)(?:\\/(\\d+))?').exec(u.pathname);
  if (play) return { seasonId: play[1], epId: play[2] || null };

  const video = new RegExp(loc + 'video\\/(\\d+)').exec(u.pathname);
  if (video) return { aid: video[1] };

  return null;
}

/* A share link is a redirect and nothing else. safeFetch refuses private
   addresses and follows a bounded number of hops, so the long form comes
   back from it without this file needing its own guard.
   
   GET rather than HEAD because bili.im answers 405 to a HEAD — measured,
   and the reason the .com path's expandShort has quietly been doing a GET
   all along (it passes {method:'HEAD'} where safeFetch takes an Accept
   header, so the option has never reached fetch). */
async function expandShort(urlStr) {
  try {
    const { url } = await safeFetch(urlStr);
    return url || null;
  } catch (e) {
    return null;
  }
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
function issueToken(epId, qn, sealedJar, ttlMs, kind) {
  const ttl = typeof ttlMs === 'number' ? ttlMs : TOKEN_TTL_MS;
  /* A user upload's id is marked, not given a field of its own, so a token
     issued before this existed still reads as the episode it always was. */
  const id = (kind === 'aid' ? 'a' : '') + epId;
  const body = ['b1', Date.now() + ttl, id, qn, sealedJar || ''].join('.');
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
  const [, exp, rawId, qn, sealed] = parts;
  if (!/^\d+$/.test(exp) || !/^a?\d+$/.test(rawId) || !/^\d+$/.test(qn)) return null;

  const expected = signToken(body);
  if (!expected) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  if (Number(exp) <= Date.now()) return null;
  const isAid = rawId[0] === 'a';
  return {
    epId: isAid ? null : rawId,
    aid: isAid ? rawId.slice(1) : null,
    qn: Number(qn),
    sealed: sealed || null
  };
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
function pickRenditions(playurl, wantQn) {
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
  return { video: video, audio: audio };
}

/* The DASH form of the pick. api/bstar.js also writes an HLS form of the
   same pick for Apple (lib/bstar-hls.js), so the choosing is shared. */
function buildManifest(playurl, wantQn, origin) {
  const pick = pickRenditions(playurl, wantQn);
  if (!pick) return null;
  const video = pick.video;
  const audio = pick.audio;

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

/* Where this code is RUNNING, which for bilibili.tv is not a detail. The
 * catalogue is licensed per country and the gate is applied to the address
 * request, so the region the function executes in — not the region the
 * viewer is sitting in — decides what will play. Vercel sets VERCEL_REGION;
 * off Vercel there is nothing to name and the wording drops the clause. */
const REGION_CITY = {
  sin1: 'Singapore', hnd1: 'Tokyo', icn1: 'Seoul', hkg1: 'Hong Kong',
  bom1: 'Mumbai', syd1: 'Sydney', iad1: 'Washington, D.C.', sfo1: 'San Francisco',
  cdg1: 'Paris', fra1: 'Frankfurt', lhr1: 'London', arn1: 'Stockholm',
  dub1: 'Dublin', gru1: 'Sao Paulo', cle1: 'Cleveland', pdx1: 'Portland'
};

function whereWeResolve() {
  const r = process.env.VERCEL_REGION;
  if (!r) return null;
  return REGION_CITY[r] || r;
}

/* What bilibili.tv says when it will not hand over an address.
 *
 * Measured 2026-09-12 by resolving the same twenty titles from three places:
 * a box in Singapore, this app running in Vercel's iad1 (Washington) and the
 * same app running in sin1 (Singapore).
 *
 *   10004001  DIFFERS BY REGION. Two titles refused with it in Washington
 *             played from both Singapore vantages. This is the geo-gate.
 *   10004404  identical from every vantage, and the `message` beside it is
 *             Chinese text about activity tags that has nothing to do with
 *             the request. A delisted title, not a region refusal — which is
 *             why it must not be reported as one.
 *      -404   an episode id bilibili.tv does not know. Previously reported as
 *             "likely region-locked"; the measurement above shows that guess
 *             was simply wrong, since region has its own code.
 *
 * An unrecognised code keeps its number in the text. A number that can be
 * looked up later beats a sentence invented to sound tidy, and it is never
 * the upstream's raw Chinese, which tells the reader nothing. */
function describeRefusal(code, cookie) {
  if (code === 10004001) {
    const city = whereWeResolve();
    return 'Bilibili TV does not license that title in the region this app ' +
      'resolves from' + (city ? ' (' + city + ')' : '') + '. Its catalogue is ' +
      'set per country, so a title can play in the app on your phone and still ' +
      'be refused here. Signing in does not lift it.';
  }
  if (code === 10004404) {
    return 'Bilibili TV no longer carries that title. The link still opens, ' +
      'but there is nothing behind it to play.';
  }
  if (code === 10015001 || code === 10023013) {
    const city = whereWeResolve();
    return 'Bilibili TV does not license that upload in either region this ' +
      'app can ask from' + (city ? ' (' + city + ', and Hong Kong as the ' +
      'second try)' : '') + '. It can play in the app on your phone and ' +
      'still be refused here — the catalogue is set per country and the ' +
      'gate is on the address request, not on the film.';
  }
  if (code === -404) {
    return cookie
      ? 'Bilibili TV does not know that episode — check the link.'
      : 'Bilibili TV would not serve that one to a signed-out request. Sign in ' +
        'to bilibili.tv below and try again.';
  }
  return 'Bilibili TV would not give an address for it' +
    (code == null ? '.' : ' (code ' + code + ').');
}

/* ------------------------------------------------------------------ *
 * The second vantage.
 *
 * One region cannot serve both halves of this site. Measured 2026-09-12,
 * twenty series and sixteen user uploads, five regions:
 *
 *              series      uploads
 *   sin1        8/20        13/16
 *   hkg1        6/20        16/16
 *   hnd1        6/20        16/16
 *   icn1        6/20        16/16
 *   bom1        6/20         0/16
 *
 * Singapore is the best place to ask about a series and a bad place to ask
 * about a film. Moving the whole app to Hong Kong would trade two series
 * for three films and still be a guess about which matters; running the
 * ADDRESS REQUEST from both and keeping whichever answers is neither.
 *
 * So api/bstar-alt.js carries a per-function `regions` of hkg1 while the
 * deployment's own region stays sin1 — one project, two vantages — and this
 * asks it only when the first answer was a region refusal.
 *
 * THE SEGMENTS DO NOT MOVE WITH IT, and that is measured too, not assumed.
 * An address resolved in hkg1 answers 403 to a fetch FROM hkg1 and 206 with
 * exact bytes from sin1, twice over. The resolve leg and the fetch leg want
 * opposite sides of the same border, which is the whole reason this is a
 * relay for one call rather than a region change for the app.
 * ------------------------------------------------------------------ */

function altSign(body) {
  const s = auth.secret();
  if (!s) return null;
  return crypto.createHmac('sha256', s).update('bstar-alt|' + body).digest('base64url');
}

/* The same upstream request, made from the other region. Returns the same
   shape `get` does, or null if the relay could not be used at all — a null
   is "no second opinion", never "refused", so a caller cannot mistake a
   relay outage for an answer. */
async function getVia(altOrigin, url, cookie) {
  if (!altOrigin) return null;
  const body = JSON.stringify({ u: url, c: cookie || '', exp: Date.now() + ALT_TTL_MS });
  const sig = altSign(body);
  if (!sig) return null;

  const headers = { 'content-type': 'application/json', 'x-bstar-alt': sig };

  /* A preview deployment sits behind Vercel's SSO, and that applies to this
     deploy calling ITSELF — the relay would answer a login page and the
     second vantage would silently never work anywhere but production. Vercel
     injects the automation bypass as an env var when one exists; sending it
     is what makes a preview testable. Production has no such variable and
     needs none. */
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(String(altOrigin).replace(/\/+$/, '') + ALT_PATH, {
      method: 'POST',
      headers: headers,
      body: body,
      signal: ctl.signal
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || typeof j.body !== 'string') return null;
    let parsed = null;
    try { parsed = JSON.parse(j.body); } catch (e) { parsed = null; }
    return { status: j.status, body: parsed };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* One address request.
 *
 * `target` is {epId} for a series episode or {aid} for a user upload. The
 * endpoint is the same for both and only the parameter differs — mapped by
 * watching what bilibili.tv's own player asks for, not guessed — which is
 * why this is one function with two keys rather than two functions.
 */
async function playurlFor(target, qn, cookie, altOrigin) {
  const key = target && target.aid
    ? 'aid=' + encodeURIComponent(target.aid)
    : 'ep_id=' + encodeURIComponent(target.epId);

  const url = API + '/web/playurl' +
    '?s_locale=en_US&platform=web&' + key +
    '&qn=' + encodeURIComponent(qn) + '&device=wap&tf=0&type=0';

  let res = await get(url, cookie);
  let code = res.body ? res.body.code : null;
  let alt = false;

  /* A body that would not parse is bilibili's risk-control page — an HTML
     interstitial served with 412 to a host it has decided not to answer. It
     is the same class of problem as a region refusal (this address cannot
     ask) and the same remedy applies, which is also what makes the resolver
     usable from a development machine: this one is 412'd outright while the
     deployment is not. */
  const blocked = res.body === null;

  if (blocked || (code !== 0 && REGION_CODES.indexOf(code) !== -1)) {
    const second = await getVia(altOrigin, url, cookie);
    if (second && second.body && second.body.code === 0) {
      res = second;
      code = 0;
      alt = true;
    }
  }

  if (!res.body || res.body.code !== 0 || !res.body.data || !res.body.data.playurl) {
    return { code: code };
  }
  return { playurl: res.body.data.playurl, viaAlt: alt };
}

async function playurl(epId, qn, cookie, altOrigin) {
  return playurlFor({ epId: epId }, qn, cookie, altOrigin);
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
/* What a user upload is called.
 *
 * There is no detail endpoint for one — the page is server-rendered and the
 * player only ever asks for the address, the subtitles and the danmaku, so
 * there is nothing to call that returns a title on its own. Two sources,
 * in the order of how much they can be trusted:
 *
 *   the playlist the upload sits in, which names each item exactly; it
 *   answers `data: null` for an upload that is in no playlist, which is a
 *   miss rather than an error and is treated as one
 *
 *   the page's own <title>, minus the site's suffix
 *
 * A film with neither keeps its number. A made-up name would be worse than
 * a number on a television's now-playing line. */
async function ugcTitle(aid) {
  const res = await get(API + '/web/v2/ugc/playlist' +
    '?s_locale=en_US&platform=web&aid=' + encodeURIComponent(aid));
  const items = res.body && res.body.data && res.body.data.items;
  if (Array.isArray(items)) {
    const mine = items.find((i) => String(i.aid) === String(aid));
    if (mine && mine.title) return String(mine.title);
  }

  try {
    const { res } = await safeFetch('https://www.bilibili.tv/en/video/' +
      encodeURIComponent(aid), 'text/html');
    if (res && res.ok) {
      const html = await res.text();
      const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html);
      if (m) {
        const t = m[1].replace(/\s*-\s*BiliBili\s*$/i, '').trim();
        if (t) return t;
      }
    }
  } catch (e) { /* a title is a nicety; a missing one is not a failure */ }

  return null;
}

/* A user upload: one id, one address request, no episode list.
 *
 * Kept beside the series path rather than folded into it because the two
 * share only the manifest. A series has a season, an episode list and a
 * name assembled from both; an upload has a number and whatever the site
 * calls it. Merging them would mean a function whose every second line asks
 * which kind it is holding. */
async function resolveUgc(aid, cookie, origin) {
  const play = await playurlFor({ aid: aid }, 80, cookie, origin);
  if (!play.playurl) {
    return { ok: false, error: describeRefusal(play.code, cookie), code: play.code };
  }

  const built = buildManifest(play.playurl, 80, origin);
  if (!built) {
    return {
      ok: false,
      error: cookie
        ? 'Bilibili TV returned no playable rendition for that one.'
        : 'Every rendition Bilibili TV offered for that one is behind its ' +
          'sign-in. Sign in to bilibili.tv below and try again.'
    };
  }

  const token = issueToken(aid, built.quality, null, null, 'aid');
  if (!token) return { ok: false, error: 'This deploy could not sign the manifest.' };

  const title = (await ugcTitle(aid)) || ('Video ' + aid);
  const quality = QUALITY_NAMES[built.quality] || ('q' + built.quality);

  return {
    ok: true,
    finalUrl: 'https://www.bilibili.tv/en/video/' + aid,
    title: title,
    referer: REFERER,
    signedIn: Boolean(cookie),
    capped: !cookie && built.quality <= 32,
    media: [{
      url: String(origin || '').replace(/\/+$/, '') + '/api/bstar?t=' + encodeURIComponent(token),
      kind: 'DASH',
      label: title + ' · ' + quality,
      detail: 'Bilibili TV · ' + quality +
        (built.bytes ? ' · ' + Math.round(built.bytes / 1e6) + ' MB' : ''),
      bytes: built.bytes,
      seconds: Math.round((play.playurl.duration || 0) / 1000) || null,
      viaProxy: false
    }]
  };
}

async function resolve(urlStr, cookie, origin) {
  let target = parseTarget(urlStr);
  if (!target) return null;

  if (!auth.secret()) {
    return { ok: false, error: 'This deploy has no signing secret, so it cannot ' +
      'authorise a manifest for the television. Set CAST_PASSWORD and redeploy.' };
  }

  /* A bili.im share, expanded before anything is read out of it. If it lands
     on bilibili.com the answer is not a refusal — it is the other resolver's
     to give, so the long form is handed back for api/extract to route. */
  if (target.short) {
    const long = await expandShort(target.short);
    if (!long) {
      return { ok: false, error: 'That bili.im link did not lead anywhere.' };
    }
    const next = parseTarget(long);
    if (!next) return { ok: false, handoff: long };
    target = next;
  }

  if (target.aid) return resolveUgc(target.aid, cookie, origin);

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
  const play = await playurl(epId, 80, cookie, origin);
  if (!play.playurl) {
    return { ok: false, error: describeRefusal(play.code, cookie), code: play.code };
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
  isBstarHost, isBstarShortHost, originOf, parseTarget, expandShort, verifyJar,
  resolve, episodes, seasonTitle, ugcTitle, playurl, playurlFor, buildManifest, pickRenditions, proxied,
  issueToken, readToken, REFERER, API, UA, ALT_PATH, ALT_TTL_MS,
  REGION_CODES, QUALITY_NAMES
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
module.exports.describeRefusal = describeRefusal;
module.exports.REGION_CITY = REGION_CITY;
