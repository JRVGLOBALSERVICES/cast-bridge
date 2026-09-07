/* GET /api/extract?url=<page>
 *
 * Reads a page server-side and reports every media reference on it, so the
 * app can offer a stream to play or cast. Browsers can't do this themselves:
 * cross-origin pages are unreadable from client JS, and nearly every site
 * refuses to be framed.
 *
 * This is a fetch and a parse, not a browser. A player that builds its
 * source in JavaScript is invisible here — when that happens the answer is
 * "nothing found, try the deep scan", never a bare empty success. The deep
 * scan at /api/scan does run a browser and does see those.
 */

const {
  MAX_RESULTS, MEDIA_EXT, safeFetch, readCapped, kindOf, labelFor, extract,
  expandHlsMaster, walledService, walledMessage,
  normalizeShare, collectFrames, collectCandidates, probeMedia, probeAll, readFrames
} = require('../lib/media');
const auth = require('../lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'Use GET.' }));
    return;
  }

  const user = await auth.guard(req, res);
  if (!user) return;

  const raw = (req.query && req.query.url) ||
    new URL(req.url, 'http://localhost').searchParams.get('url');

  if (!raw) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'No address given.' }));
    return;
  }

  let target = String(raw).trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  /* A Drive or Dropbox share link names the file in its path; the address
     that serves the bytes is a fixed rewrite of it, so rewrite it before
     spending a fetch on the viewer page wrapped around it. */
  target = normalizeShare(target);

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
        error: 'That page answered ' + pageRes.status + '. It may need a login, or it may be gone.',
        canDeepScan: true
      }));
      return;
    }

    const type = (pageRes.headers.get('content-type') || '').toLowerCase();

    /* The address was the media itself — hand it straight back. */
    const answerDirect = async (url, kind) => {
      let media = [{
        url,
        kind: kind || kindOf(url),
        label: labelFor(url),
        detail: 'direct file'
      }];
      if (media[0].kind === 'HLS') {
        const variants = await expandHlsMaster(url);
        const known = new Set(media.map((x) => x.url));
        variants.forEach((v) => {
          if (!known.has(v.url)) { media.push(v); known.add(v.url); }
        });
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: true, finalUrl: url, title: labelFor(url), poster: null,
        media: media.slice(0, MAX_RESULTS), direct: true
      }));
    };

    if (!type.includes('html') && (type.startsWith('video/') || type.startsWith('audio/') ||
        type.includes('mpegurl') || type.includes('dash+xml') ||
        MEDIA_EXT.test(finalUrl))) {
      await answerDirect(finalUrl);
      return;
    }

    if (!type.includes('html') && !type.includes('xml') && !type.includes('text')) {
      /* Neither a page nor a type that names itself media — but octet-stream
         is how a great many CDNs label an mp4, and a signed link carries no
         extension to fall back on. Refusing on the label alone would turn
         the addresses hardest to come by into the ones that don't work, so
         ask the bytes first. */
      const hit = await probeMedia(finalUrl);
      if (hit) {
        await answerDirect(hit.url, hit.kind);
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: false,
        error: 'That address is a ' + (type.split(';')[0] || 'file') + ', not a page or a video.'
      }));
      return;
    }

    const html = await readCapped(pageRes);

    /* Served as text, but it is a manifest rather than a page. A signed
       manifest carries no extension to give it away, and parsing one as
       HTML finds nothing — which comes back as "no video on that page"
       about an address that IS the video. */
    if (/^\s*#EXTM3U/.test(html)) { await answerDirect(finalUrl, 'HLS'); return; }
    if (/<MPD[\s>]/i.test(html.slice(0, 2000)) && /urn:mpeg:dash/i.test(html)) {
      await answerDirect(finalUrl, 'DASH');
      return;
    }

    const parsed = extract(html, finalUrl);
    let via = null;

    /* Nothing on the page itself is not the end of the quick scan any more.
       Two more places an ordinary address hides, tried in the order that
       pays off most often, and only when the first pass came back empty so
       a page that already answered stays as fast as it was.

         1. Frames. A wrapper page has no player of its own; the host it
            delegates to does. One hop, in parallel, ad and analytics
            frames skipped.
         2. Candidates. The address is in the player config but its name
            gives nothing away, which is true of almost every signed CDN
            link. These are fetched, and the first few kilobytes of the
            answer decide — never the name. */
    if (!parsed.media.length) {
      const framed = await readFrames(collectFrames(html, finalUrl), finalUrl);
      if (framed.media.length) {
        parsed.media = framed.media;
        via = 'embedded player';
      } else {
        const probed = await probeAll(
          collectCandidates(html, finalUrl).concat(framed.candidates)
        );
        if (probed.length) {
          parsed.media = probed;
          via = 'player config';
        }
      }
    }

    /* Master playlists get expanded into their real quality variants. */
    const masters = parsed.media.filter((x) => x.kind === 'HLS').slice(0, 2);
    if (masters.length) {
      const known = new Set(parsed.media.map((x) => x.url));
      for (const master of masters) {
        const variants = await expandHlsMaster(master.url);
        variants.forEach((v) => {
          if (!known.has(v.url)) { parsed.media.push(v); known.add(v.url); }
        });
      }
      parsed.media = parsed.media.slice(0, MAX_RESULTS);
    }

    /* An empty list is not a success. Saying "ok" with nothing in it is how
       a working scan and a blind one look identical to whoever is holding
       the phone. Name the reason and offer the thing that can still work. */
    if (!parsed.media.length) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: false,
        empty: true,
        canDeepScan: true,
        finalUrl,
        title: parsed.title,
        error: 'No video link is written into that page. Its player probably ' +
          'builds one in JavaScript after loading, which a quick scan cannot see.'
      }));
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      finalUrl,
      title: parsed.title,
      poster: parsed.poster,
      media: parsed.media,
      direct: false,
      via
    }));
  } catch (err) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false,
      error: (err && err.message) || "That page couldn't be read.",
      canDeepScan: true
    }));
  }
};
