/* A cover, fetched by us instead of by the phone.
 *
 *   GET /api/img?u=<address of a poster>
 *
 * Why this exists at all. The picture on a notification and on the lock
 * screen is a plain <img> load, and a hotlinked poster is exactly the kind
 * of image a site refuses: it sees a Referer that is not its own and
 * answers 403. In the page that is a broken-image glyph; in the shade
 * there is no glyph and no second chance, so artwork.js drops it and the
 * notification falls back to the grey app mark. That is the "no cover"
 * report — the address was found, returned and thrown away at the last
 * inch because the host would not serve it to us.
 *
 * Fetching it here fixes two things at once:
 *   1. The request carries the poster's OWN origin as its referer, which
 *      is what hotlink protection is actually checking.
 *   2. The result comes back on this origin, so the Chromecast — which
 *      fetches the artwork itself, from its own network, with no session
 *      and no cookies — can get it too. A cover the phone can see and the
 *      television cannot is half a fix.
 *
 * Unauthenticated for the same reason /api/subs?id= is: the client is a
 * television. What keeps that honest is that it is not a general proxy.
 * Every hop is checked against private address space by safeFetch, the
 * body is capped well below any real poster, and the only thing that can
 * ever leave here is a response whose content-type the upstream itself
 * declared as an image. Anything else is refused rather than passed on.
 */

const { safeFetch } = require('../lib/media');

/* A 4K poster in JPEG is around 1.5 MB. Five is room to spare and still
   far too small to be useful to anyone hoping to move a film through it. */
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;

/* An image response and nothing else. SVG is excluded on purpose: it is a
   document, it can carry script, and no poster anywhere is one. */
const ALLOWED = /^image\/(jpeg|png|webp|gif|avif|bmp)\b/i;

async function readBinaryCapped(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_BYTES ? null : buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch (e) { /* already closed */ }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function fail(res, code, why) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: why }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    return fail(res, 405, 'Only GET.');
  }

  const url = new URL(req.url, 'http://localhost');
  const target = (url.searchParams.get('u') || '').trim();
  if (!target) return fail(res, 400, 'No address given.');

  let parsed;
  try { parsed = new URL(target); } catch (e) { return fail(res, 400, 'That is not an address.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail(res, 400, 'Only http and https.');
  }

  let hit;
  try {
    hit = await safeFetch(parsed.toString(), 'image/avif,image/webp,image/*,*/*;q=0.8', {
      timeoutMs: TIMEOUT_MS,
      /* The site's own page is what a browser would have been showing when
         it asked for this picture, and it is what hotlink protection wants
         to see. Nothing here pretends to be a person — it says where the
         picture was referenced from, which is true. */
      headers: { referer: parsed.origin + '/' }
    });
  } catch (e) {
    /* safeFetch's own refusals say something useful — an address inside a
       private network, a host that will not resolve, a site that never
       answered — and collapsing all three into one sentence throws away
       the only diagnosis this endpoint can offer. */
    return fail(res, 502, e.message || 'That cover could not be fetched.');
  }

  if (!hit.res.ok) return fail(res, 502, 'That cover answered ' + hit.res.status + '.');

  const type = (hit.res.headers.get('content-type') || '').split(';')[0].trim();
  if (!ALLOWED.test(type)) return fail(res, 415, 'That address is not an image.');

  const body = await readBinaryCapped(hit.res);
  if (!body || !body.length) return fail(res, 502, 'That cover was empty or too large.');

  res.statusCode = 200;
  res.setHeader('content-type', type);
  res.setHeader('content-length', String(body.length));
  /* A television fetches this from its own network, so it needs the header
     a cross-origin client needs, and posters do not change under an
     address — a day of caching keeps a re-cast from re-fetching. */
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'public, max-age=86400');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(req.method === 'HEAD' ? undefined : body);
};
