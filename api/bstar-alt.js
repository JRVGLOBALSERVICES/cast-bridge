/* POST /api/bstar-alt  —  the same question, asked from Hong Kong.
 *
 * This file exists for one reason: bilibili.tv answers differently depending
 * on where the asking happens, and no single region answers well for both
 * halves of its catalogue. Measured 2026-09-12 over twenty series and sixteen
 * user uploads —
 *
 *              series      uploads
 *   sin1        8/20        13/16     ← the deployment's own region
 *   hkg1        6/20        16/16     ← this function's region
 *   hnd1        6/20        16/16
 *   icn1        6/20        16/16
 *   bom1        6/20         0/16
 *
 * — so the deployment stays in Singapore, where series resolve best, and this
 * one function carries `regions: ["hkg1"]` in vercel.json. lib/bstar asks it
 * for a second opinion only when the first answer carried a region refusal.
 *
 * WHY ONLY THE RESOLVE MOVES. An address resolved in hkg1 answers 403 to a
 * fetch FROM hkg1 and 206 with exact bytes from sin1 — reproduced twice. The
 * segment proxy has to stay where it is; moving the app would have broken
 * playback while appearing to fix the catalogue.
 *
 * NOT A PUBLIC PROXY. The body is signed with the deploy secret and expires
 * in sixty seconds, the URL must be an api.bilibili.tv gateway address, and
 * the response is the upstream's JSON and nothing else. Without the secret
 * this endpoint does nothing at all, which is the point: it is one internal
 * hop, not an open relay someone could point at their own host.
 */

const crypto = require('crypto');
const auth = require('../lib/auth');
const bstar = require('../lib/bstar');

const MAX_BODY = 8192;

function fail(res, code, message) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: message }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) { reject(new Error('too big')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { fail(res, 405, 'Method not allowed.'); return; }

  const secret = auth.secret();
  if (!secret) { fail(res, 503, 'This deploy has no signing secret.'); return; }

  let raw;
  try { raw = await readBody(req); } catch (e) { fail(res, 413, 'Too large.'); return; }

  /* Signature before parse, so a malformed body cannot reach the parser on
     an unsigned request. */
  const sig = String(req.headers['x-bstar-alt'] || '');
  const expected = crypto.createHmac('sha256', secret).update('bstar-alt|' + raw).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    fail(res, 403, 'Not signed for this deploy.');
    return;
  }

  let body;
  try { body = JSON.parse(raw); } catch (e) { fail(res, 400, 'Bad body.'); return; }

  if (!body || !Number.isFinite(body.exp) || body.exp <= Date.now()) {
    fail(res, 403, 'Expired.');
    return;
  }

  /* The host is fixed, not merely checked — the one call this relay is for
     is an address request, and an allow-list of one is the smallest thing
     that cannot be walked outwards later. */
  const url = String(body.u || '');
  if (url.indexOf(bstar.API + '/') !== 0) {
    fail(res, 400, 'Not a bilibili.tv gateway address.');
    return;
  }

  const headers = {
    'user-agent': bstar.UA,
    referer: bstar.REFERER,
    accept: 'application/json, text/plain, */*'
  };
  if (body.c) headers.cookie = String(body.c);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const up = await fetch(url, { headers: headers, signal: ctl.signal, redirect: 'follow' });
    const text = await up.text();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(JSON.stringify({ status: up.status, region: process.env.VERCEL_REGION || null, body: text.slice(0, 262144) }));
  } catch (e) {
    fail(res, 502, 'The second region could not reach Bilibili TV.');
  } finally {
    clearTimeout(timer);
  }
};
