/* GET /api/stream?u=<media-file>[&r=<page-it-was-playing-on>]
 *
 * Re-serves a stream so a television can fetch it. Two things stop a
 * Chromecast reading a resolved address directly, and neither has anything
 * to do with how the address was found:
 *
 *   - The host serves segments only to a request that carries the page they
 *     were embedded in. A receiver on the television sends no such header,
 *     so it gets a 403 on every segment while the same URL plays fine in
 *     the tab it came from.
 *   - Google's Cast media documentation requires HLS and DASH to be served
 *     cross-origin-open. A CDN that never expected a receiver does not.
 *
 * Both are fixed by one hop. This forwards the referer the media expects,
 * and answers with the header the receiver needs. HLS playlists are rewritten
 * so every segment, key and map inside them comes back through here too —
 * a manifest that passes but whose segments do not is a black screen with
 * a spinner, which is worse than a clean failure.
 *
 * DASH is relayed but NOT rewritten. An .mpd's segment paths resolve
 * against wherever the manifest was served from, which here is a query
 * string, so a rewrite would have to reconstruct its whole BaseURL tree.
 * The front end knows this and does not route DASH here by default.
 *
 * Unauthenticated for the same reason /api/subs is: the fetcher is a
 * television, which carries no session and cannot be given one. What keeps
 * that from being an open proxy is that every hop is checked against
 * private address space by safeFetch, and the content type is checked
 * against media before a byte is passed on — an address that answers with
 * a web page is refused rather than relayed.
 */

const { Readable } = require('stream');

/* Backpressure that gives up when the far end does.
 *
 * `once(res, 'drain')` waits for a socket that has already gone away: a
 * television that is switched off mid-film, or a viewer who hits Stop,
 * closes the response without ever draining it. The await then never
 * settles, and the async iterator holding the upstream body is never
 * returned — so the connection to the origin stays open for as long as the
 * process does.
 *
 * On Vercel that leak was invisible; the invocation was killed at 60
 * seconds and took the whole isolate with it. This handler now also runs
 * inside a long-lived server, where nothing comes along to clean up after
 * it, so the wait has to lose the race to `close`. Rejecting unwinds the
 * for-await, which returns the iterator, which destroys the source and
 * aborts the fetch. */
const CLIENT_GONE = 'client-gone';

function drain(res) {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) {
      reject(new Error(CLIENT_GONE));
      return;
    }
    const done = (err) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      err ? reject(err) : resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error(CLIENT_GONE));
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}
const { safeFetch, readCapped, UA } = require('../lib/media');
const { reissue, deepReissue } = require('../lib/reissue');

/* Long enough for a segment on a slow CDN, short enough that a dead host
   fails while the receiver is still willing to retry. */
const STREAM_TIMEOUT_MS = 20000;

/* Said only when the page WAS asked again and still could not produce a
   working address. Naming the retry is the difference between "the link is
   dead" — which sends someone hunting for another copy of the film — and
   "the page has stopped handing them out", which is answered by scanning
   the page again. */
const NO_PAGE_NOTE =
  ' No page is known for this link, so a fresh one could not be asked for.' +
  ' Open the page it came from in Browse and pick the video there.';
const REISSUE_NOTE =
  ' The page it came from was asked for a fresh address and could not give one — ' +
  'scan the page again.';

/* WHY THERE IS NO HAND-OFF HERE.
 *
 * There was one, for a day. Some CDNs sign a media address to the NETWORK
 * that asked for it rather than to a clock — measured on vmpx.online,
 * which puts the fact in the address: `asn=14618` is Amazon's, because the
 * deep scan ran on the Vercel function. The same signed link, in the same
 * minute, answered 200 there and 403 to this box in Singapore. Nothing
 * expired and nothing was wrong with it; it simply was not ours.
 *
 * The quick fix was to redirect those to the bridge the address DID belong
 * to. It worked, and it was the wrong fix: the whole reason this VPS
 * exists is that a film through Vercel is billed twice — once
 * function-to-CDN, once CDN-to-television, around $0.27/GB with no free
 * origin allowance — so a redirect that sends exactly the films this box
 * cannot fetch back through the meter defeats the purpose of the box. A
 * cost fix whose failure mode is the cost is not a fix.
 *
 * The address is now minted where it will be fetched instead. lib/reissue
 * re-asks the page from here — first from its HTML, then, for the players
 * that build their source in JavaScript, from a headless browser running
 * on this machine. What comes back is signed to this network, so there is
 * nothing left to hand off, and no film byte leaves Vercel.
 *
 * If this ever needs a second host again, it must be another box that
 * costs nothing per gigabyte, and it must be added as a re-issue rather
 * than a redirect — the television must never be pointed at a meter.
 */

/* Vercel gives this function 60 seconds, and a receiver asking a
   progressive file for "everything from here on" means one response that
   has to carry the rest of the film. At the 3.7 Mbit/s a 3-hour 5 GB
   encode averages, that single response is three hours long, so the
   function is killed mid-film and the television sees the stream die —
   the failure gets worse the longer the film is, which is exactly
   backwards.

   An open-ended or oversized range is therefore answered a window at a
   time: the range sent upstream is narrowed, and the 206 that comes back
   already describes the narrower window, so nothing has to be rewritten
   on the way out. The player reads the window, sees from Content-Range
   that the file continues, and asks for the next one. That is ordinary
   HTTP — CDNs cap ranges the same way — and it puts a ceiling on how long
   any single invocation can run regardless of how big the file is.

   8 MiB is about 17 seconds of that same encode: long enough that the
   round trips are rare, short enough to transfer well inside the limit
   even from a slow origin.

   The ceiling is a property of the host, not of the format, so it is
   settable. Behind a server with no execution limit a wider window is
   strictly better — the same film in fewer, longer reads — and
   STREAM_RANGE_WINDOW_MB is how that host says so. Unset, this is the
   8 MiB Vercel needs. */
const RANGE_WINDOW_BYTES = (function () {
  const mb = Number(process.env.STREAM_RANGE_WINDOW_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 8 * 1024 * 1024;
})();

/* Only a single well-formed byte range is narrowed. A suffix range
   (bytes=-N) is asking for the tail, which is how a player finds an mp4's
   moov box and is small by nature; a multipart range is rare enough that
   passing it through untouched is safer than reasoning about it. */
function narrowRange(header) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return { header: header, narrowed: false };

  const start = Number(m[1]);
  if (!Number.isFinite(start)) return { header: header, narrowed: false };
  const end = m[2] === '' ? Infinity : Number(m[2]);
  if (!(end >= start)) return { header: header, narrowed: false };
  if (end - start + 1 <= RANGE_WINDOW_BYTES) return { header: header, narrowed: false };

  return {
    header: 'bytes=' + start + '-' + (start + RANGE_WINDOW_BYTES - 1),
    narrowed: true
  };
}

/* Enough of the front of a body to find an image header's end and check
   what follows it. The wrapper measured in the wild ended at byte 120. */
const HEAD_PEEK_BYTES = 4096;

const PLAYLIST_TYPE = /mpegurl|m3u/i;
const REFUSED_TYPE = /^text\/html|^application\/xhtml/i;

/* Types we pass on as themselves. Everything else that is not refused
   outright is relayed as opaque bytes instead, which is both what the
   receiver wants and what stops this endpoint re-serving a third party's
   content type from our origin.

   Not an allowlist of what may be fetched, because it cannot be: streams
   in the wild are routinely mislabelled, and the segments of a real one
   tested against this came back as image/png from an image CDN. Refusing
   those would have meant refusing the stream. */
const MEDIA_TYPE =
  /^(video|audio|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|mp4|iso\.segment))/i;

/* The refusal in the host's own words, appended to ours. A link locked to
   the network that found it gets named as that, because the fix for it is
   "play it on the phone", not "scan again". */
function hostSaid(opened, ours) {
  const said = opened && opened.said;
  if (!said) return ours;
  if (/wrong_?ip/i.test(said)) {
    return 'That link is locked to the network that found it, so the bridge cannot fetch it ' +
      '(host said "' + said + '"). Play it on the phone, or scan the page again from here.';
  }
  return ours + ' Host said: "' + said + '".';
}

/* Media address (without query) → the page it was found on. Per process:
   long-lived on the stream host, which is where films play; on a Vercel
   instance it is simply a smaller memory. */
const PAGE_MEMORY_MAX = 500;
const pageMemory = new Map();
function mediaKey(u) {
  try { const x = new URL(u); return x.host + x.pathname; } catch (e) { return String(u); }
}
function rememberPage(media, page) {
  if (!/^https?:\/\//i.test(page)) return;
  const k = mediaKey(media);
  pageMemory.delete(k);
  pageMemory.set(k, page);
  if (pageMemory.size > PAGE_MEMORY_MAX) pageMemory.delete(pageMemory.keys().next().value);
}
function pageFor(media) {
  return pageMemory.get(mediaKey(media)) || '';
}

function fail(res, status, message) {
  res.statusCode = status;
  /* The reason, where a log can reach it. A <video> that gets this answer
     reports only "format error"; the phone reads the header back into its
     cast log, and the stream host writes it on the request's log line.
     Exposed, because a cross-origin fetch cannot otherwise read it. */
  try {
    res.setHeader('X-Cast-Error', encodeURIComponent(String(message)).slice(0, 1000));
    res.setHeader('Access-Control-Expose-Headers', 'X-Cast-Error');
  } catch (e) { /* headers already gone */ }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: message }));
}

/* Everything inside a playlist has to come back through here, or the
   receiver fetches the segments itself and hits the same two walls the
   manifest just cleared. */
function proxied(absUrl, referer) {
  let out = '/api/stream?u=' + encodeURIComponent(absUrl);
  if (referer) out += '&r=' + encodeURIComponent(referer);
  return out;
}

/* Rewrites an HLS playlist in place: every media line, and the URI="..."
   of the tags that carry one. A key line matters as much as a segment —
   an AES-128 playlist whose key URI is left pointing at the origin fails
   on the television with nothing but a decode error. */
function rewritePlaylist(text, baseUrl, referer) {
  const attrUri = /URI="([^"]*)"/;

  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed[0] === '#') {
      if (!/^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT)/.test(trimmed)) {
        return line;
      }
      const m = trimmed.match(attrUri);
      if (!m || !m[1]) return line;
      let abs;
      try { abs = new URL(m[1], baseUrl).toString(); } catch (e) { return line; }
      return line.replace(attrUri, 'URI="' + proxied(abs, referer) + '"');
    }

    let abs;
    try { abs = new URL(trimmed, baseUrl).toString(); } catch (e) { return line; }
    return proxied(abs, referer);
  }).join('\n');
}

/* Some hosts park their segments on an image CDN, which will only carry
 * something that begins like an image. What comes back is a real, valid,
 * one-pixel PNG with the whole MPEG-TS segment appended after its closing
 * chunk — the site's own player strips the header before handing the rest
 * to the decoder, and anything that does not gets a file ffprobe calls a
 * 1x1 image and a television refuses outright.
 *
 * Measured on a live stream: PNG signature, IEND at byte 112, and from
 * byte 120 the transport stream, sync byte holding across every 188-byte
 * packet from there to the end.
 *
 * Returns the offset the media actually starts at, or 0 when the body is
 * what it says it is. Deliberately narrow: it strips only when a media
 * container is sitting immediately behind the image, so a genuine image
 * passes through untouched.
 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);

function mediaStartsAt(head) {
  let after = -1;

  if (head.length > 8 && head.subarray(0, 8).equals(PNG_SIG)) {
    const iend = head.indexOf('IEND', 0, 'latin1');
    if (iend > 0) after = iend + 8;          /* IEND + its 4-byte CRC */
  } else if (head.length > 3 && head.subarray(0, 3).equals(JPEG_SIG)) {
    const eoi = head.indexOf(Buffer.from([0xff, 0xd9]));
    if (eoi > 0) after = eoi + 2;
  }

  if (after < 0 || after >= head.length) return 0;

  /* Only strip if what follows is really a container. A transport stream
     is checked across several packets rather than on one byte, because a
     lone 0x47 inside image data would otherwise truncate a real picture. */
  const rest = head.subarray(after);
  if (rest[0] === 0x47) {
    const packets = Math.min(8, Math.floor(rest.length / 188));
    if (packets >= 2) {
      for (let n = 0; n < packets; n++) if (rest[n * 188] !== 0x47) return 0;
      return after;
    }
  }
  /* An mp4/fMP4 segment instead: a box header, four bytes in. */
  if (rest.length > 8 && /^(ftyp|styp|moof|sidx)$/.test(rest.subarray(4, 8).toString('latin1'))) {
    return after;
  }
  return 0;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(res, 405, 'Use GET.');
    return;
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  const raw = (req.query && req.query.u) || params.get('u');
  const refRaw = (req.query && req.query.r) || params.get('r');
  /* The page the media was found on, and the quality that was picked.
     `r` already carries the page for anything that came out of a scan, so
     `p` is only for a caller that wants to name it separately. The label
     matters because these hosts serve every quality as the same filename —
     without it, a re-issued address is the right film at the wrong size. */
  let pageRaw = (req.query && req.query.p) || params.get('p') || refRaw;
  const wantLabel = (req.query && req.query.q) || params.get('q') || '';

  if (!raw) {
    fail(res, 400, 'No stream address given.');
    return;
  }

  let target = String(raw).trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  /* The page this film was found on, remembered from an earlier request
     that named it. A link opened on its own (pasted, opened in the in-app
     browser) arrives naming itself, or nothing, as its page — and then
     nothing can re-issue it once the host locks it to another network.
     Measured 16 Sep 2026: the same vkcdn link played at 16:50:06 with its
     page and 502'd at 16:50:56 without it. */
  let pageRemembered = false;
  if (pageRaw && String(pageRaw) !== target) {
    rememberPage(target, String(pageRaw));
  } else {
    const known = pageFor(target);
    if (known) { pageRaw = known; pageRemembered = true; }
    else pageRaw = pageRaw && String(pageRaw) !== target ? pageRaw : '';
  }

  /* The page the media was embedded in, which is what the host is checking
     for. Absent that, its own origin is the closest honest answer and is
     what most hosts accept. */
  let referer = '';
  const refUse = pageRemembered ? pageRaw : (refRaw && String(refRaw) !== target ? refRaw : '');
  try {
    referer = refUse ? new URL(String(refUse)).toString() : new URL(target).origin + '/';
  } catch (e) {
    referer = new URL(target).origin + '/';
  }

  const headers = {
    referer: referer,
    origin: new URL(referer).origin,
    'user-agent': UA
  };
  /* Seeking on the television is a Range request. Dropping it here turns
     every seek into a full refetch from zero. */
  const ranged = !!req.headers.range;
  let narrowed = false;
  if (ranged) {
    const win = narrowRange(req.headers.range);
    headers.range = win.header;
    narrowed = win.narrowed;
  }

  /* One open, and what it means. A refusal is not only a status: the host
     behind the vkprime embed answers a stranger's request with 200 and
     fourteen bytes of HTML, which relays as a perfectly successful nothing
     unless the type is read too. */
  const openOnce = async (url, refererOverride, bare) => {
    /* A re-issued address belongs to the document that just handed it
       over, not to the page the viewer started from. */
    const h = bare
      ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'referer' && k !== 'origin'))
      : refererOverride
      ? Object.assign({}, headers, {
        referer: refererOverride,
        origin: new URL(refererOverride).origin
      })
      : headers;
    const got = await safeFetch(url, '*/*', { headers: h, timeoutMs: STREAM_TIMEOUT_MS });
    const t = (got.res.headers.get('content-type') || '').toLowerCase();
    const refused = (!got.res.ok && got.res.status !== 206) || REFUSED_TYPE.test(t);
    /* What the host actually said when it refused. "403" and "a web page"
       are two very different answers once the words are read: vkcdn's
       200 + "Error_wrong_ip" means the link is locked to another network,
       not that it is dead. Only a refusal is read — never a film. */
    let said = '';
    if (refused) {
      try {
        said = (await readCapped(got.res)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      } catch (e) { said = ''; }
    }
    return { res: got.res, url: got.url, type: t, refused, said };
  };

  const discard = (r) => {
    /* cancel() REJECTS (not throws) on a body already read or locked — a
       refusal whose words were read for the report is exactly that. A
       rejection nobody handles takes the whole stream host down. */
    try {
      const p = r && r.res && r.res.body && !r.res.body.locked && r.res.body.cancel();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* already gone */ }
  };

  let opened = null;
  let openError = null;
  /* Set once the page has been asked for a replacement and could not
     supply a working one. It changes what the failure MEANS: not "this
     link is dead" but "this link was not ours, and the page would not
     issue another". Without it the report names the wrong cause and sends
     the viewer looking for the wrong fix. */
  let reissueFailed = false;
  try {
    opened = await openOnce(target);
  } catch (e) {
    openError = e;
  }

  /* Some hosts refuse ANY referer — vkcdn answers 403 to the page's own
     address and serves the file only to a request that names none. So a
     refusal with a referer gets one more try without it, before the far
     dearer re-issue. Measured 16 Sep 2026: Referer tvarticles.org → 403,
     none → the file (or Error_wrong_ip when the link is not ours). */
  if (opened && opened.refused && headers.referer) {
    let bareTry = null;
    try { bareTry = await openOnce(target, null, true); } catch (e) { bareTry = null; }
    /* Kept even when it too refuses, if it says why: without the referer
       the host names the real problem instead of a bare 403. */
    if (bareTry && (!bareTry.refused || bareTry.said)) { discard(opened); opened = bareTry; }
    else discard(bareTry);
  }

  /* Refused, or unreachable, but we know the page it came from.
   *
   * Some hosts sign an address to the network that asked for it, so the
   * one the phone was given is not one this server may use — and the
   * refusal looks identical to a dead link. Ask the page again from here
   * and it hands over an address of our own. Same host only, one retry.
   * lib/reissue.js has the measurements. */
  if ((!opened || opened.refused) && pageRaw) {
    discard(opened);
    /* Kept so the report can name what actually happened. Every path below
       either replaces it with a working stream or puts it back — a refusal
       we could not repair is still the honest answer, and it is a better
       one than whatever the last repair attempt failed with. */
    const first = opened;
    opened = null;
    reissueFailed = true;

    /* Two ways to be handed an address of our own, cheapest first. The
       HTML re-read is a fetch; the deep one is a browser on this machine
       and costs seconds, so it only runs when the cheap one had nothing —
       which is most of the pages this app is pointed at, because a player
       that builds its source in JavaScript leaves no address in the HTML.
       On a host with no browser configured the second is a no-op. */
    const sources = [
      () => reissue(String(pageRaw), target, wantLabel),
      () => deepReissue(String(pageRaw), target, wantLabel)
    ];

    for (const ask of sources) {
      let fresh = null;
      try {
        fresh = await ask();
      } catch (e) {
        fresh = null;
      }
      if (!fresh || !fresh.url) continue;

      let retry = null;
      try {
        retry = await openOnce(fresh.url, fresh.referer);
      } catch (e) {
        continue;
      }
      if (retry.refused) { discard(retry); continue; }

      reissueFailed = false;
      opened = retry;
      openError = null;
      target = fresh.url;
      rememberPage(target, String(pageRaw));
      break;
    }

    if (!opened) opened = first;
  }

  if (!opened) {
    fail(res, 502, (openError && openError.message) || "That stream couldn't be reached.");
    return;
  }

  const upstream = opened.res;
  const finalUrl = opened.url;
  const type = opened.type;

  if (!upstream.ok && upstream.status !== 206) {
    /* 403 here is the referer check refusing us, which is the one failure
       worth naming — it means the address is real but the host wants a
       different page in the header than the one we were told. */
    const why0 = upstream.status === 403
      ? 'That host refused the stream (403). It expects the page it was embedded in.'
      : 'That stream answered ' + upstream.status + '.';
    const why = hostSaid(opened, why0);
    fail(res, 502, why + (reissueFailed ? REISSUE_NOTE : '') + (pageRaw ? '' : NO_PAGE_NOTE));
    return;
  }

  const path = finalUrl.split('?')[0];
  const isPlaylist = PLAYLIST_TYPE.test(type) || /\.m3u8?$/i.test(path);

  /* A page where a stream should be is the ordinary shape of a dead link
     or a login redirect, and it is the one answer worth naming rather than
     relaying — both because it is never playable and because serving
     someone else's HTML from our origin is the thing this endpoint most
     needs not to do. */
  if (REFUSED_TYPE.test(type)) {
    fail(res, 415, hostSaid(opened, 'That address is a web page, not a stream.') +
      (reissueFailed ? REISSUE_NOTE : '') + (pageRaw ? '' : NO_PAGE_NOTE));
    return;
  }

  if (isPlaylist) {
    let body;
    try {
      body = await readCapped(upstream);
    } catch (e) {
      fail(res, 502, 'That playlist could not be read.');
      return;
    }
    const rewritten = rewritePlaylist(body, finalUrl, referer);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    /* A live playlist is rewritten on every refresh; caching it would
       freeze the stream on the segment list it had when it was first
       fetched. */
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : rewritten);
    return;
  }

  res.statusCode = upstream.status === 206 ? 206 : 200;
  /* Anything not recognisably media goes out as bytes under its own name
     rather than the label upstream gave it. With nosniff above, that is
     inert whatever it actually was, and a receiver reading segments does
     not care what they are called. */
  res.setHeader('Content-Type', MEDIA_TYPE.test(type) ? type : 'application/octet-stream');
  ['content-length', 'content-range', 'accept-ranges'].forEach((h) => {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  });
  if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  /* A segment at a given address is immutable — the playlist changes, the
     segment does not. Letting the receiver cache it saves a refetch on
     every rebuffer. */
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  /* A host that ignored the narrowed range and sent the whole file back
     anyway would undo the ceiling silently. Say so in a header rather than
     leaving it to be inferred from a timeout. */
  if (narrowed) {
    res.setHeader('X-Cast-Bridge-Window', upstream.status === 206
      ? String(RANGE_WINDOW_BYTES) : 'ignored');
  }

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }

  /* Read enough of the front to tell a disguised segment from a real
     image, then stream the remainder. Piped rather than buffered from
     there on: a segment is megabytes and a progressive mp4 is the whole
     film, and holding either in memory is how this function runs out of
     it. Only the head is ever held. */
  const source = Readable.fromWeb(upstream.body);

  try {
    let head = Buffer.alloc(0);
    let started = false;

    for await (const chunk of source) {
      if (started) { if (!res.write(chunk)) await drain(res); continue; }

      head = Buffer.concat([head, chunk]);
      if (head.length < HEAD_PEEK_BYTES) continue;

      /* An offset shifts every byte after it, so the length and range we
         copied from upstream no longer describe what we are sending. A
         request that asked for part of the file is left alone instead —
         detection needs byte zero, and segments are fetched whole. */
      const at = ranged ? 0 : mediaStartsAt(head);
      if (at) {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Range');
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Content-Type', 'video/mp2t');
        res.statusCode = 200;
      }
      started = true;
      if (!res.write(head.subarray(at))) await drain(res);
    }

    /* A body shorter than the peek never reached the branch above. */
    if (!started) {
      const at = ranged ? 0 : mediaStartsAt(head);
      if (at) {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Range');
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Content-Type', 'video/mp2t');
        res.statusCode = 200;
      }
      res.write(head.subarray(at));
    }
    res.end();
  } catch (e) {
    /* The viewer stopping is not a fault and must not be reported as one:
       the socket is already gone, so there is nobody to tell. */
    if (e && e.message === CLIENT_GONE) {
      source.destroy();
      return;
    }
    if (!res.headersSent) fail(res, 502, 'That stream broke while being read.');
    else res.end();
  }
};

/* Exported for the playlist-rewrite test. A key line that is left pointing
   at the origin fails on the television as a decode error with no network
   trace, so this branch is worth being able to assert on directly. */
module.exports.rewritePlaylist = rewritePlaylist;

/* Exported for the range-window test. */
module.exports.narrowRange = narrowRange;
