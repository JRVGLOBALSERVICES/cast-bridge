/* Telling somebody's phone something, from the box that knows it.
 *
 * This host finishes an upload whether or not the app that started it is
 * still on screen — the phone can lock, the tab can be frozen, the person
 * can walk off. The response to that upload goes to a page that may no
 * longer be listening, and until now that was the end of it: the file was
 * ready to cast and nothing said so.
 *
 * This host cannot draw a notification itself. It has no VAPID key, no
 * subscription table and no session — all three live on the app half, which
 * is a different origin on somebody else's servers. So it asks: one POST to
 * /api/push carrying a shared secret and the uid it read out of the signed
 * ticket the upload already presented.
 *
 * Deliberately one-way and send-only. The token opens exactly one door — ask
 * for a push to be sent to a named user — and cannot read a subscription,
 * delete one, or reach anything else in the app.
 *
 * Every failure here is swallowed. A push is a courtesy on top of an upload
 * that already succeeded; turning "the notification could not be sent" into
 * "your upload failed" would be a strictly worse app.
 */

'use strict';

function endpoint() {
  const origin = (process.env.CAST_APP_ORIGIN || 'https://cast.jrvsystems.app').replace(/\/+$/, '');
  return origin + '/api/push';
}

function token() {
  return (process.env.CAST_PUSH_HOOK_TOKEN || '').trim();
}

function configured() {
  return token().length > 0;
}

/* Returns what the app answered, or a reason it did not. Callers do not have
   to await it — but the caller in stream-server.js does, so that the line it
   logs is the truth about what happened rather than a hope. */
async function notify(uid, payload) {
  if (!configured()) return { ok: false, error: 'no CAST_PUSH_HOOK_TOKEN' };
  if (!uid) return { ok: false, error: 'no uid' };

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cast-push-token': token()
      },
      body: JSON.stringify({ uid, payload }),
      /* Short. An upload response must not wait on a push service having a
         bad afternoon — the person is holding a phone looking at a spinner
         that finished. */
      signal: AbortSignal.timeout(6000)
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* keep the status */ }
    if (!res.ok) return { ok: false, error: (j && j.error) || ('app answered ' + res.status) };
    return j || { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { notify, configured, endpoint };
