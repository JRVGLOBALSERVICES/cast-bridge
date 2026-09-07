/* Short-lived tickets for the stream host.
 *
 * The app's own session is an HttpOnly cookie on the Vercel origin. The
 * stream host is a different origin on a different machine, so that cookie
 * is never sent to it and JavaScript cannot read it to forward it. Nor
 * should the stream host be handed the session secret: the two boxes have
 * different jobs and a compromise of the file server must not become a
 * compromise of everyone's account.
 *
 * So the Vercel side, which HAS the session, mints a ticket: a signed
 * statement that this account may do this one thing for the next few
 * minutes. The stream host verifies the signature and the clock, and needs
 * no database, no cookie and no knowledge of who anybody is.
 *
 * STREAM_UPLOAD_SECRET is set on both. A missing one fails shut on both —
 * the Vercel side cannot mint and the stream host cannot verify, so uploads
 * stop rather than becoming public.
 */

const crypto = require('crypto');

const VERSION = 't1';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/* Long enough that guessing is not a strategy. Refusing a short one is the
   difference between a shared secret and a shared password. */
const MIN_SECRET_LEN = 24;

function secret() {
  const s = process.env.STREAM_UPLOAD_SECRET;
  if (s && s.length >= MIN_SECRET_LEN) return s;
  return null;
}

function configured() {
  return Boolean(secret());
}

function sign(body) {
  const s = secret();
  if (!s) return null;
  return crypto.createHmac('sha256', s).update(body).digest('base64url');
}

/* `scope` names what the ticket permits: 'upload', 'storage'. It is part of
   the signed body, so an upload ticket cannot be replayed at the delete
   endpoint. */
function mint(userId, scope, ttlMs) {
  if (!userId || !scope) return null;
  if (!/^[0-9a-z-]{1,64}$/i.test(String(userId))) return null;
  if (!/^[a-z]{1,16}$/.test(String(scope))) return null;
  const exp = Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS);
  const body = [VERSION, exp, scope, userId].join('.');
  const sig = sign(body);
  return sig ? body + '.' + sig : null;
}

/* Returns { uid, scope, exp } or null. Never throws — it is reading input
   from the open internet. */
function check(token, wantScope) {
  if (!token || typeof token !== 'string' || token.length > 512) return null;

  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const parts = body.split('.');
  if (parts.length !== 4) return null;
  const [ver, exp, scope, uid] = parts;
  if (ver !== VERSION) return null;
  if (!/^\d{10,16}$/.test(exp)) return null;
  if (!/^[a-z]{1,16}$/.test(scope)) return null;
  if (!/^[0-9a-z-]{1,64}$/i.test(uid)) return null;

  const expected = sign(body);
  if (!expected) return null;

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  /* timingSafeEqual throws on a length mismatch, which is itself a leak of
     nothing useful — but it throws, so check first. */
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  if (Number(exp) <= Date.now()) return null;
  if (wantScope && scope !== wantScope) return null;

  return { uid, scope, exp: Number(exp) };
}

/* Both hosts read the ticket from the same two places, in the same order:
   an Authorization header where one can be set, and a query parameter where
   one cannot. A <video> element fetching a file cannot send a header. */
function fromRequest(req) {
  const h = (req.headers && req.headers.authorization) || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (m) return m[1];
  if (req.query && req.query.t) return String(req.query.t);
  try {
    return new URL(req.url, 'http://x').searchParams.get('t');
  } catch (e) {
    return null;
  }
}

module.exports = { mint, check, configured, fromRequest, DEFAULT_TTL_MS };
