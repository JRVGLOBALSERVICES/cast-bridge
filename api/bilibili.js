/* Signing in to Bilibili, from this app.
 *
 *   GET  /api/bilibili?action=status   is there a session, and whose
 *   POST /api/bilibili?action=start    begin a QR sign-in, get the key + URL
 *   GET  /api/bilibili?action=poll&key=…   has the phone confirmed yet
 *   POST /api/bilibili?action=paste    take a session off the clipboard
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
 *
 * Why `paste` as well: the QR needs two devices, one to show it and one to
 * point at it. With one phone there is no second screen, and the Bilibili
 * app has no address bar to paste the sign-in address into — so on a single
 * phone the QR flow has no ending. `paste` is the way through: sign in on
 * bilibili.com in any browser, copy the cookie, hand it over here. Same
 * destination, same signed cookie, no camera.
 */

const auth = require('../lib/auth');
const bili = require('../lib/bilibili');

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 16384) throw new Error('Too much data.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new Error('That request was not readable.');
  }
}

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

  if (action === 'paste') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { ok: false, error: 'That sign-in was not readable.' });
    }

    const jar = bili.parseCookieText(body && body.cookie);
    if (!jar) {
      return send(res, 400, {
        ok: false,
        error: 'No SESSDATA in that. Copy the whole cookie line from a browser ' +
          'that is signed in to bilibili.com — SESSDATA is the part that matters.'
      });
    }

    /* Asked before it is kept, so a mistyped or already-dead paste says so
       now rather than turning into a video that quietly drops to 720p a
       week later. */
    const who = await bili.whoami(bili.cookieHeader(jar));
    if (!who) {
      return send(res, 400, {
        ok: false,
        error: 'Bilibili does not recognise that session. It may have been ' +
          'copied incompletely, or it has since expired — sign in to ' +
          'bilibili.com again and copy a fresh one.'
      });
    }

    const cookie = bili.setJarHeader(jar);
    if (!cookie) {
      return send(res, 503, {
        ok: false,
        error: 'This deploy cannot sign a session, so the Bilibili login has ' +
          'nowhere safe to be kept. Set CAST_SECRET.'
      });
    }
    return send(res, 200, {
      ok: true, signedIn: true, name: who.name, vip: who.vip
    }, cookie);
  }

  if (action === 'signout') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
    return send(res, 200, { ok: true, signedIn: false }, bili.clearJarHeader());
  }

  return send(res, 400, { ok: false, error: 'Unknown action.' });
};
