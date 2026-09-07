/* Session endpoint.
 *
 *   GET    /api/auth  -> { ok, signedIn, user, configured }
 *   POST   /api/auth  -> { username, password } sets the session cookie
 *   DELETE /api/auth  -> signs out
 *
 * Failures are counted per IP and per username. Per IP alone lets one
 * attacker on many addresses grind a single account; per username alone lets
 * one address grind many accounts. Both, or neither is worth having.
 */

const auth = require('../lib/auth');
const users = require('../lib/users');
const db = require('../lib/db');

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const IP_LIMIT = 15;
const USER_LIMIT = 8;
const fails = new Map(); // key -> { n, until }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function blocked(key, limit) {
  const rec = fails.get(key);
  if (!rec) return false;
  if (Date.now() > rec.until) { fails.delete(key); return false; }
  return rec.n >= limit;
}

function noteFailure(key) {
  const rec = fails.get(key);
  if (!rec || Date.now() > rec.until) {
    fails.set(key, { n: 1, until: Date.now() + FAIL_WINDOW_MS });
    return;
  }
  rec.n += 1;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 4096) throw new Error('Too much data.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new Error('That request was not readable.');
  }
}

function shape(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const ready = db.configured() && auth.configured();

  if (req.method === 'GET') {
    let user = null;
    if (ready) {
      try { user = await auth.currentUser(req); } catch (e) { user = null; }
    }
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      signedIn: Boolean(user),
      user: shape(user),
      configured: ready
    }));
    return;
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, signedIn: false, user: null }));
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'Use GET, POST or DELETE.' }));
    return;
  }

  if (!ready) {
    res.statusCode = 503;
    res.end(JSON.stringify({
      ok: false,
      error: 'This app has no accounts connected yet. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CAST_ADMIN_USER and CAST_ADMIN_PASSWORD in the project settings, then redeploy.'
    }));
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: e.message }));
    return;
  }

  const username = String((body && body.username) || '').trim();
  const password = (body && body.password) || '';

  if (!username || !password) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'Enter your username and password.' }));
    return;
  }

  const ip = clientIp(req);
  const nameKey = 'u:' + username.toLowerCase();
  if (blocked(ip, IP_LIMIT) || blocked(nameKey, USER_LIMIT)) {
    res.statusCode = 429;
    res.end(JSON.stringify({
      ok: false,
      error: 'Too many wrong tries. Wait a few minutes and try again.'
    }));
    return;
  }

  /* Seed the owner from env on the first sign-in against an empty table, so a
     fresh deploy never needs a console step. Cheap when it is a no-op. */
  try {
    await users.ensureSeedAdmin();
  } catch (e) {
    /* An unseedable store is not a reason to reject a user who already
       exists — fall through and let authenticate() decide. */
  }

  let row;
  try {
    row = await users.authenticate(username, password);
  } catch (e) {
    res.statusCode = e.status === 503 ? 503 : 502;
    res.end(JSON.stringify({
      ok: false,
      error: 'Could not reach the account store. Try again in a moment.'
    }));
    return;
  }

  if (!row) {
    noteFailure(ip);
    noteFailure(nameKey);
    /* One message for wrong name, wrong password and disabled account. Three
       messages would be a directory of who has an account here. */
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: 'That username and password do not match.' }));
    return;
  }

  const token = auth.issue(row.id);
  if (!token) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: 'This app is not configured to sign you in.' }));
    return;
  }

  fails.delete(ip);
  fails.delete(nameKey);
  users.touch(row.id);

  res.setHeader('Set-Cookie', auth.setCookieHeader(token));
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, signedIn: true, user: shape(row) }));
};
