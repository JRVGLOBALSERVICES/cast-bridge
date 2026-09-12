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
const bstar = require('../lib/bstar');

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 262144) throw new Error('Too much data.');
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

  /* bilibili.tv is a separate sign-in kept in a separate cookie, so it comes
   * through the same three actions with ?site=tv rather than a parallel set
   * of endpoints. Anything not named 'tv' stays the .com path, which is what
   * every existing caller sends.
   *
   * There is no QR flow here: bstar publishes no qrcode endpoint, so `start`
   * and `poll` are .com-only and the tv path is paste or nothing.
   */
  if (String(params(req).site || '') === 'tv') {
    if (action === 'status') {
      const jar = bstar.jarFromRequest(req);
      if (!jar) return send(res, 200, { ok: true, signedIn: false });
      /* Unlike the .com side this cannot name the account — bstar has no nav
         endpoint. It reports what the session is worth instead. */
      const level = await bstar.verifyJar(jar);
      if (level === 'basic') {
        return send(res, 200, {
          ok: true, signedIn: true, hd: false,
          note: 'Signed in, but nothing above 480p came back on the reference ' +
            'title. The session may have lapsed, or that title may simply not ' +
            'offer more.'
        });
      }
      return send(res, 200, { ok: true, signedIn: true, hd: level === 'hd' });
    }

    if (action === 'paste') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
      let body;
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { ok: false, error: 'That sign-in was not readable.' });
      }

      const jar = bstar.parseCookieText(body && body.cookie);
      if (!jar) {
        const why = bstar.diagnoseCookieText(body && body.cookie);
        return send(res, 400, {
          ok: false,
          error: why || 'No SESSDATA in that. Copy the whole cookie line from a ' +
            'browser that is signed in to bilibili.tv — SESSDATA is the part ' +
            'that matters. A cookies.txt file exported from that browser works too.'
        });
      }

      const cookie = bstar.setJarHeader(jar);
      if (!cookie) {
        return send(res, 503, {
          ok: false,
          error: 'This deploy cannot sign a session, so the Bilibili TV login ' +
            'has nowhere safe to be kept. Set CAST_SECRET.'
        });
      }

      /* Kept even when the reference title could not be reached. A paste that
         parses is not proven bad by an upstream that did not answer, and
         throwing it away would send someone back to copy the same value. */
      const level = await bstar.verifyJar(bstar.cookieHeader(jar));
      return send(res, 200, {
        ok: true, signedIn: true, hd: level === 'hd', checked: level !== null
      }, cookie);
    }

    if (action === 'signout') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
      return send(res, 200, { ok: true, signedIn: false }, bstar.clearJarHeader());
    }

    return send(res, 400, {
      ok: false,
      error: 'bilibili.tv has no QR sign-in — bstar publishes no qrcode ' +
        'endpoint. Paste a cookie instead.'
    });
  }

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
      /* A cookies.txt names its own domains, so a refusal can often say
         which mistake was made rather than repeating the requirement. */
      const why = bili.diagnoseCookieText(body && body.cookie);
      return send(res, 400, {
        ok: false,
        error: why || 'No SESSDATA in that. Copy the whole cookie line from a ' +
          'browser that is signed in to bilibili.com — SESSDATA is the part ' +
          'that matters. A cookies.txt file exported from that browser works too.'
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
