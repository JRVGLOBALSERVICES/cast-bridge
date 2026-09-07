/* Session auth for Cast Bridge.
 *
 * v2. The v1 scheme was one shared password in CAST_PASSWORD and a cookie
 * that carried nothing but an expiry — there was no identity in it, so there
 * was nothing to scope history by. This version puts the user id in the
 * cookie and signs the pair.
 *
 * The cookie is signed, not encrypted. It carries an expiry and a user id,
 * both of which the server would tell you anyway; the signature is what makes
 * it unforgeable. Nothing secret rides in it.
 */

const crypto = require('crypto');
const users = require('./users');

const COOKIE = 'cb_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — this is a TV remote, not a bank

/* A missing secret must never mean "everything validates". Derive one from
   whatever identity material the deploy does have, and when there is none,
   return null so every signature check fails shut. */
function secret() {
  const explicit = process.env.CAST_SECRET;
  if (explicit && explicit.length >= 16) return explicit;

  const fallback =
    process.env.CAST_ADMIN_PASSWORD ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.CAST_PASSWORD;
  if (!fallback) return null;
  return crypto.createHash('sha256').update('cast-bridge/v2|' + fallback).digest('hex');
}

function configured() {
  return Boolean(secret());
}

function sign(payload) {
  const s = secret();
  if (!s) return null;
  return crypto.createHmac('sha256', s).update(payload).digest('base64url');
}

function issue(userId) {
  if (!userId) return null;
  const body = 'v2.' + (Date.now() + TTL_MS) + '.' + userId;
  const sig = sign(body);
  return sig ? body + '.' + sig : null;
}

/* Returns the user id the token vouches for, or null. Deliberately does not
   touch the database — a forged token must be rejected before it can cost a
   query. */
function subject(token) {
  if (!token || typeof token !== 'string') return null;

  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const parts = body.split('.');
  if (parts.length !== 3 || parts[0] !== 'v2') return null;
  const [, exp, uid] = parts;
  if (!/^\d+$/.test(exp)) return null;
  if (!/^[0-9a-f-]{36}$/i.test(uid)) return null;

  const expected = sign(body);
  if (!expected) return null;

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  if (Number(exp) <= Date.now()) return null;
  return uid;
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

/* The account behind the request, or null. A valid signature over a user who
   has since been deleted or disabled is not a session — the row is the
   authority, the cookie only names it. */
async function currentUser(req) {
  const uid = subject(readCookie(req, COOKIE));
  if (!uid) return null;
  let row;
  try {
    row = await users.byId(uid);
  } catch (e) {
    return null;
  }
  if (!row || !row.active) return null;
  return row;
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

function deny(res, status, error, extra) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(Object.assign({ ok: false, error }, extra || {})));
  return null;
}

/* Every protected endpoint calls this first. Returns the user row when the
   caller may proceed; returns null having already answered the request when
   they may not. Callers must check for null and return. */
async function guard(req, res) {
  const db = require('./db');
  if (!db.configured()) {
    return deny(res, 503,
      'This app has no user store connected yet, so it is locked. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the project settings.');
  }
  if (!configured()) {
    return deny(res, 503,
      'This app cannot sign anyone in yet. Set CAST_ADMIN_USER and CAST_ADMIN_PASSWORD in the project settings.');
  }
  const user = await currentUser(req);
  if (!user) return deny(res, 401, 'Sign in first.', { needsAuth: true });
  return user;
}

/* Admin-only endpoints layer this on top. Same contract: null means answered. */
async function guardAdmin(req, res) {
  const user = await guard(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    return deny(res, 403, 'Only the owner can manage accounts.');
  }
  return user;
}

module.exports = {
  /* `secret` is exported so anything else that needs to sign something for
     this deploy derives it the same way rather than retyping the fallback
     chain. A second copy of that chain is a second thing to keep in step,
     and the failure mode is a signature that validates in one file and not
     in the other. */
  secret,
  COOKIE, TTL_MS, configured, issue, subject, readCookie,
  currentUser, setCookieHeader, clearCookieHeader, guard, guardAdmin
};
