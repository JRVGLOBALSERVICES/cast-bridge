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
  expandHlsMaster, walledService, walledMessage
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

  if (!auth.guard(req, res)) return;

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
        error: 'That page answered ' + pageRes.status + '. It may need a login, or it may be gone.',
        canDeepScan: true
      }));
      return;
    }

    const type = (pageRes.headers.get('content-type') || '').toLowerCase();

    /* The address was the media itself — hand it straight back. */
    if (!type.includes('html') && (type.startsWith('video/') || type.startsWith('audio/') ||
        type.includes('mpegurl') || type.includes('dash+xml') ||
        MEDIA_EXT.test(finalUrl))) {
      let media = [{
        url: finalUrl,
        kind: kindOf(finalUrl),
        label: labelFor(finalUrl),
        detail: 'direct file'
      }];
      if (media[0].kind === 'HLS') {
        const variants = await expandHlsMaster(finalUrl);
        const known = new Set(media.map((x) => x.url));
        variants.forEach((v) => {
          if (!known.has(v.url)) { media.push(v); known.add(v.url); }
        });
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: true, finalUrl, title: labelFor(finalUrl), poster: null,
        media: media.slice(0, MAX_RESULTS), direct: true
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
      direct: false
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
