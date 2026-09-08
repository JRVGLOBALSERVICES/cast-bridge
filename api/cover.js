/* The made-up cover, as an image a television can fetch.
 *
 *   GET /api/cover?t=<title>&f=<where it came from>&w=&h=
 *
 * Why this exists when the phone can already draw the card itself. A
 * Chromecast fetches artwork on its own, from its own network, with no
 * session and no cookies — the same reason /api/img exists. The card the
 * phone draws is a canvas, and a canvas is a data: URL: perfectly good for
 * this phone's lock screen and useless to a receiver across the room, which
 * has nothing to go and get. So the card is drawn a second time here, from
 * the same module, as something with an address.
 *
 * Unauthenticated, for the same reason /api/img and /api/subs are: the
 * client is a television. What keeps that honest is that this endpoint
 * fetches nothing, reads nothing and touches no state. It takes two short
 * strings and returns an arithmetic function of them. There is no upstream
 * to be pointed at, so there is nothing here to be used as a proxy.
 *
 * The one real hazard is that an SVG is a document and can carry script,
 * which is exactly why api/img.js refuses to pass one through. This one is
 * not passed through, it is composed — every piece of text goes through the
 * module's escape on the way in — and it is served under a policy that
 * forbids the document from loading or running anything at all. Both, not
 * either: the escaping is the fix, and the header is what makes a mistake
 * in the escaping survivable.
 */

const cover = require('../assets/js/cover.js');

/* Long enough for any real film title, including a Chinese one where every
   character is a word. Past this the card would be ellipsised anyway — the
   cap is about what arrives, not about what is drawn. */
const MAX_TITLE = 200;
const MAX_FROM = 80;

/* Small enough that this is pointless as a way to spend our CPU, large
   enough for a 4K receiver's idle screen. */
const MIN_SIDE = 160;
const MAX_SIDE = 2048;

/* An absent parameter takes the default; a present one is clamped. The
   difference matters because Number(null) is 0, not NaN — so a missing
   width read as a number and clamped comes back as the MINIMUM side, and
   every television that asked for nothing in particular would have been
   sent a 160-pixel card. */
function size(v, fallback) {
  if (v === null || String(v).trim() === '') return fallback;
  const n = Math.round(Number(v));
  if (!isFinite(n)) return fallback;
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, n));
}

/* Control characters, and the two line separators that would otherwise
   arrive as a real newline inside an attribute. Not a security measure —
   the escape in the module is that — but a card is one line of type and
   these are not type. */
function clean(s, max) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('allow', 'GET, HEAD');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'Only GET.' }));
  }

  const url = new URL(req.url, 'http://localhost');
  const title = clean(url.searchParams.get('t'), MAX_TITLE);
  const from = clean(url.searchParams.get('f'), MAX_FROM);

  /* 16:9 by default, because the usual caller is a television. The phone
     asks for a square, and asks by drawing its own. */
  const body = cover.svg({
    title: title,
    from: from,
    width: size(url.searchParams.get('w'), 1280),
    height: size(url.searchParams.get('h'), 720)
  });

  res.statusCode = 200;
  res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
  res.setHeader('content-length', String(Buffer.byteLength(body)));
  /* A document that may load nothing, run nothing and go nowhere. The
     escaping upstream is what stops a title becoming markup; this is what
     stops a title that got past it from becoming anything. */
  res.setHeader('content-security-policy', "default-src 'none'; sandbox");
  res.setHeader('x-content-type-options', 'nosniff');
  /* The receiver is a separate client on the same network. Without this it
     fetches the card and refuses to draw it. */
  res.setHeader('access-control-allow-origin', '*');
  /* The card is a pure function of the query string, so an address that
     returned one card can never return a different one. */
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  res.end(req.method === 'HEAD' ? undefined : body);
};
