/* Session auth for Cast Bridge.
 *
 * The app is a personal tool on a public URL, so "who else can use it" is
 * decided here and nowhere else. There are no accounts — one shared password,
 * checked against CAST_PASSWORD, exchanged for a signed cookie.
 *
 * The cookie is signed, not encrypted: it carries only an expiry, and the
 * signature is what makes it unforgeable. Nothing secret rides in it.
 */

const crypto = require('crypto');

const COOKIE = 'cb_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — this is a TV remote, not a bank

/* A missing secret must never mean "everything validates". Derive one from
   the password so a half-configured deploy is still locked, and treat a
   missing password as "locked shut" rather than "open to everyone". */
function secret() {
  const explicit = process.env.CAST_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  const pw = process.env.CAST_PASSWORD;
  if (!pw) return null;
  return crypto.createHash('sha256').update('cast-bridge/v1|' + pw).digest('hex');
}

function configured() {
  return Boolean(process.env.CAST_PASSWORD);
}

function sign(payload) {
  const s = secret();
  if (!s) return null;
  return crypto.createHmac('sha256', s).update(payload).digest('base64url');
}

function issue() {
  const exp = String(Date.now() + TTL_MS);
  const sig = sign(exp);
  return sig ? exp + '.' + sig : null;
}

function valid(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;

  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return false;

  const expected = sign(exp);
  if (!expected) return false;

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  return Number(exp) > Date.now();
}

/* Compare in constant time so a wrong password can't be narrowed by timing. */
function passwordMatches(given) {
  const real = process.env.CAST_PASSWORD;
  if (!real || typeof given !== 'string') return false;

  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function authed(req) {
  return valid(readCookie(req, COOKIE));
}

function setCookieHeader(token) {
  const bits = [
    COOKIE + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.floor(TTL_MS / 1000)
  ];
  /* Secure is right everywhere it can be set, but a browser drops a Secure
     cookie on plain http, which would make the local dev server impossible
     to sign in to. Vercel is https-only, so this is off only on localhost. */
  if (!process.env.CAST_INSECURE_COOKIE) bits.splice(3, 0, 'Secure');
  return bits.join('; ');
}

function clearCookieHeader() {
  const secure = process.env.CAST_INSECURE_COOKIE ? '' : ' Secure;';
  return COOKIE + '=; Path=/; HttpOnly;' + secure + ' SameSite=Lax; Max-Age=0';
}

/* Every protected endpoint calls this first. Returns true when the caller
   may proceed; when it returns false it has already answered the request. */
function guard(req, res) {
  if (!configured()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: false,
      error: 'This app has no password set yet, so it is locked. Set CAST_PASSWORD in the project settings.'
    }));
    return false;
  }
  if (!authed(req)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'Sign in first.', needsAuth: true }));
    return false;
  }
  return true;
}

module.exports = {
  COOKIE, TTL_MS, configured, issue, valid, passwordMatches,
  readCookie, authed, setCookieHeader, clearCookieHeader, guard
};
