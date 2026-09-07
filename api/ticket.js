/* GET /api/ticket?scope=upload|storage
 *
 * Trades the session cookie this origin can read for a short-lived signed
 * ticket the stream host can verify. Nothing else in the app talks to the
 * stream host with any authority; this is the single door.
 *
 * `storage` is owner-only. Everyone signed in may upload something to cast;
 * only the owner may see what is on the disk and delete it, because that
 * list is everybody's files at once. `library` is the same disk seen from
 * the other end — one person's own uploads — so it is open to everyone and
 * scoped by the uid the stream host reads out of the ticket.
 */

const auth = require('../lib/auth');
const ticket = require('../lib/ticket');

const SCOPES = {
  upload: { ttlMs: 30 * 60 * 1000, adminOnly: false },
  storage: { ttlMs: 10 * 60 * 1000, adminOnly: true },
  /* Everyone's own shelf. Not admin-only and not a weaker `storage`: the
     stream host answers a library ticket about the uid inside it and
     nothing else, so the scope is what stops one person's list, re-date or
     delete from ever naming another person's file. */
  library: { ttlMs: 10 * 60 * 1000, adminOnly: false }
};

function params(req) {
  if (req.query) return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  } catch (e) {
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end(JSON.stringify({ ok: false, error: 'Use GET.' }));
  }

  const user = await auth.guard(req, res);
  if (!user) return; // guard has answered

  const scope = String(params(req).scope || 'upload');
  const rule = SCOPES[scope];
  if (!rule) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'Unknown scope.' }));
  }
  if (rule.adminOnly && user.role !== 'admin') {
    res.statusCode = 403;
    return res.end(JSON.stringify({ ok: false, error: 'Only the owner can do that.' }));
  }

  if (!ticket.configured()) {
    /* Said plainly rather than as a 500. The feature is off because a
       secret is missing, and the person reading this can set it. */
    res.statusCode = 503;
    return res.end(JSON.stringify({
      ok: false,
      error: 'File casting is not switched on. Set STREAM_UPLOAD_SECRET on this project and on the stream host.'
    }));
  }

  const token = ticket.mint(user.id, scope, rule.ttlMs);
  if (!token) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: 'Could not issue a ticket.' }));
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    ok: true,
    token: token,
    expiresAt: Date.now() + rule.ttlMs,
    host: process.env.STREAM_PUBLIC_HOST || 'https://stream.jrvsystems.app'
  }));
};
