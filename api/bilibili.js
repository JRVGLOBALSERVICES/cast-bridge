/* Signing in to Bilibili, from this app.
 *
 *   GET  /api/bilibili?action=status   is there a session, and whose
 *   POST /api/bilibili?action=start    begin a QR sign-in, get the key + URL
 *   GET  /api/bilibili?action=poll&key=…   has the phone confirmed yet
 *   POST /api/bilibili?action=signout  drop the session
 *
 * The session that comes back is stored in a signed HttpOnly cookie on this
 * origin (see lib/bilibili). It is the caller's own Bilibili account, so it
 * lives in the caller's browser and nowhere else — this app never holds it
 * server-side and there is no table of other people's logins to leak.
 *
 * Why QR and not a username and password: it is the only web sign-in
 * Bilibili offers that does not end in a captcha, and it is the one that
 * never puts a password through this server.
 */

const auth = require('../lib/auth');
const bili = require('../lib/bilibili');

function params(req) {
  if (req.query) return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  } catch (e) {
    return {};
  }
}

function send(res, status, body, cookie) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  const user = await auth.guard(req, res);
  if (!user) return;

  const action = String(params(req).action || 'status');

  if (action === 'status') {
    const jar = bili.jarFromRequest(req);
    if (!jar) return send(res, 200, { ok: true, signedIn: false });
    /* The cookie being present is not the same as it still working —
       Bilibili expires a session quietly and the first sign of it would
       otherwise be a video that mysteriously drops to 360p. Ask. */
    const who = await bili.whoami(jar);
    if (!who) {
      return send(res, 200, {
        ok: true, signedIn: false, lapsed: true
      }, bili.clearJarHeader());
    }
    return send(res, 200, { ok: true, signedIn: true, name: who.name, vip: who.vip });
  }

  if (action === 'start') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
    const r = await bili.qrStart();
    if (!r.ok) return send(res, 502, r);
    return send(res, 200, { ok: true, key: r.key, url: r.url });
  }

  if (action === 'poll') {
    const r = await bili.qrPoll(params(req).key);
    if (!r.ok) return send(res, 200, r);
    if (r.state !== 'ok') return send(res, 200, { ok: true, state: r.state });

    const cookie = bili.setJarHeader(r.cookies);
    if (!cookie) {
      return send(res, 503, {
        ok: false,
        error: 'This deploy cannot sign a session, so the Bilibili login has ' +
          'nowhere safe to be kept. Set CAST_SECRET.'
      });
    }
    const who = await bili.whoami(bili.cookieHeader(r.cookies));
    return send(res, 200, {
      ok: true, state: 'ok', name: (who && who.name) || 'signed in'
    }, cookie);
  }

  if (action === 'signout') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
    return send(res, 200, { ok: true, signedIn: false }, bili.clearJarHeader());
  }

  return send(res, 400, { ok: false, error: 'Unknown action.' });
};
