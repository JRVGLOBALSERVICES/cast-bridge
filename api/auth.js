/* Session endpoint.
 *
 *   GET    /api/auth  -> { ok, signedIn, configured }
 *   POST   /api/auth  -> { password } sets the session cookie
 *   DELETE /api/auth  -> signs out
 *
 * A wrong password is rate-limited per instance rather than per user: there
 * is only one password, so slowing the endpoint down slows every guesser.
 */

const auth = require('../lib/auth');

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 10;
const fails = new Map(); // ip -> { n, until }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function tooManyFailures(ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) { fails.delete(ip); return false; }
  return rec.n >= FAIL_LIMIT;
}

function noteFailure(ip) {
  const rec = fails.get(ip);
  if (!rec || Date.now() > rec.until) {
    fails.set(ip, { n: 1, until: Date.now() + FAIL_WINDOW_MS });
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

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      signedIn: auth.authed(req),
      configured: auth.configured()
    }));
    return;
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, signedIn: false }));
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, error: 'Use GET, POST or DELETE.' }));
    return;
  }

  if (!auth.configured()) {
    res.statusCode = 503;
    res.end(JSON.stringify({
      ok: false,
      error: 'No password is set for this app yet. Add CAST_PASSWORD in the project settings and redeploy.'
    }));
    return;
  }

  const ip = clientIp(req);
  if (tooManyFailures(ip)) {
    res.statusCode = 429;
    res.end(JSON.stringify({
      ok: false,
      error: 'Too many wrong tries. Wait a few minutes and try again.'
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

  if (!auth.passwordMatches(body && body.password)) {
    noteFailure(ip);
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: 'That password is wrong.' }));
    return;
  }

  const token = auth.issue();
  if (!token) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: 'This app is not configured to sign you in.' }));
    return;
  }

  fails.delete(ip);
  res.setHeader('Set-Cookie', auth.setCookieHeader(token));
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, signedIn: true }));
};
