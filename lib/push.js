/* Real push: the store, and the send.
 *
 * The half of this that is arithmetic lives in lib/push-crypto.js and is
 * proved against RFC 8291's own worked example. This half holds the database
 * and the environment, which is exactly why it is a separate file — see the
 * note at the bottom of that one.
 *
 * ── WHAT THIS FIXES, PRECISELY ──────────────────────────────────────────
 *
 * Every notification this app has ever drawn came from the PAGE. The worker
 * drew it, but only ever because a running page asked it to. So the shade
 * was accurate while the app was alive in the background and frozen the
 * moment the phone suspended the tab — which is most of the window in which
 * a notification is worth anything, and all of the window after the app is
 * closed. A push arrives at the browser, and the browser starts the worker
 * to draw it. The page does not have to exist.
 *
 * The page keeps its local path and it is not redundant: when the app IS on
 * screen and casting, it knows the position, the buffering and the percentage
 * a server never hears about. Push covers the case the page cannot: not
 * running.
 */

'use strict';

const db = require('./db');
const { vapidProblem, audienceOf, vapidJwt, encryptPush, unb64u } = require('./push-crypto');

const TABLE = 'push_subscriptions';

/* --------------------------------------------------------------------------
 * Keys
 * ----------------------------------------------------------------------- */

function keys() {
  return {
    publicKey: (process.env.CAST_VAPID_PUBLIC_KEY || '').trim(),
    privateKey: (process.env.CAST_VAPID_PRIVATE_KEY || '').trim(),
    subject: (process.env.CAST_VAPID_SUBJECT || '').trim()
  };
}

/* Null when push can run, otherwise the sentence saying why not. Reported to
   the settings panel rather than logged: the person who can fix it is
   holding a phone, and a server log is not somewhere they will look. */
function problem() {
  return vapidProblem(keys());
}

function configured() {
  return db.configured() && problem() === null;
}

/** The key the browser needs to subscribe. Public by nature — it is in every
 *  subscribe call the app makes — so it is served to any signed-in person. */
function publicKey() {
  return keys().publicKey || null;
}

/* --------------------------------------------------------------------------
 * Urgency and TTL — the two headers that decide whether it is ever seen
 * ----------------------------------------------------------------------- */

/* This header is the single most likely cause of "the notification only
 * turns up when I open the app", and it is invisible from the sending side:
 * the push service returns 201 either way.
 *
 * A Chrome-on-Android endpoint is FCM, and FCM maps web-push Urgency onto its
 * own message priority. `high` is delivered at once and is allowed to wake a
 * dozing handset. `normal` becomes a normal-priority message the platform may
 * sit on until the device next leaves Doze — which is, in practice, the moment
 * somebody picks the phone up and opens something. gfts-helm shipped every
 * push as `normal` for months and the symptom there was word for word the one
 * reported here.
 *
 * So the categories where the person is waiting on the answer are `high`, and
 * the ones that are a running commentary are not. Being honest about the
 * difference is what keeps `high` meaning anything. */
function urgencyFor(category) {
  switch (category) {
    case 'ready':     // the file finished uploading; it can be cast now
    case 'failed':    // it did not work, and nothing else will say so
    case 'test':      // asked for by hand, from the settings panel
      return 'high';
    case 'progress':  // a percentage, worth having, not worth waking a phone
    case 'cast':      // state the page usually draws better itself
    default:
      return 'normal';
  }
}

/* How long a push service should hold this if the phone is off the network.
 *
 * Not one constant. "Your film is ready" is still true tonight. "Casting to
 * the living room" delivered four hours after the fact is a lie about the
 * present, and the app has no way to withdraw it once it is on the shade —
 * so it is given a short life and allowed to expire undelivered instead. */
function ttlFor(category) {
  switch (category) {
    case 'ready':
    case 'failed':
      return 6 * 60 * 60;
    case 'test':
      return 60;
    case 'cast':
    case 'progress':
    default:
      return 15 * 60;
  }
}

/* Twelve hours. RFC 8292 caps `exp` at 24h from now and services reject a
   longer one outright; half the ceiling survives a clock that is an hour
   wrong without inventing a renewal mechanism. */
const JWT_TTL_SECONDS = 12 * 60 * 60;

/* --------------------------------------------------------------------------
 * The store
 * ----------------------------------------------------------------------- */

const enc = (v) => encodeURIComponent(String(v));

async function listFor(userId) {
  const rows = await db.select(
    TABLE + '?user_id=eq.' + enc(userId) +
    '&select=endpoint,user_id,p256dh,auth,ua,created_at,last_sent,failures,last_error'
  );
  return Array.isArray(rows) ? rows : [];
}

/* Upsert on the endpoint. The app re-subscribes on every boot — that is the
   documented way to notice a key rotation — so this must overwrite, or a
   month of opening the app is a month of duplicate rows and duplicate
   buzzes. `resolution=merge-duplicates` is PostgREST's ON CONFLICT.

   The user_id is written from the signed session by the caller and is never
   taken from the request body: a subscription is a URL that can be pushed to,
   and letting a browser name whose it is would let one person's endpoint be
   filed under another person's account. */
async function save(userId, sub, ua) {
  const row = {
    endpoint: sub.endpoint,
    user_id: userId,
    p256dh: sub.p256dh,
    auth: sub.auth,
    ua: ua ? String(ua).slice(0, 200) : null,
    failures: 0,
    last_error: null
  };
  await db.request('POST', TABLE, {
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  return row;
}

async function forget(endpoint) {
  await db.remove(TABLE + '?endpoint=eq.' + enc(endpoint));
}

/* --------------------------------------------------------------------------
 * The send
 * ----------------------------------------------------------------------- */

async function sendOne(sub, payload, now) {
  const k = keys();
  const at = now || new Date();
  const audience = audienceOf(sub.endpoint);
  const jwt = vapidJwt(k, audience, Math.floor(at.getTime() / 1000) + JWT_TTL_SECONDS);

  const encrypted = encryptPush(
    JSON.stringify(payload),
    unb64u(sub.p256dh),
    unb64u(sub.auth)
  );

  const headers = {
    Authorization: 'vapid t=' + jwt + ', k=' + k.publicKey,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttlFor(payload.category)),
    Urgency: urgencyFor(payload.category)
  };
  /* The collapse key. The app has always been one-notification-per-subject
     on the shade; this extends that back to the push service, so a second
     push about the same subject REPLACES a first one still queued for an
     offline phone rather than joining it. Without it, a handset that was in
     a tunnel for ten minutes comes back to ten stacked progress messages. */
  if (payload.tag) headers.Topic = String(payload.tag).slice(0, 32);

  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(encrypted.body),
      signal: AbortSignal.timeout(10000)
    });
    let error;
    if (!res.ok) { try { error = (await res.text()).slice(0, 300); } catch (e) { error = null; } }
    return {
      endpoint: sub.endpoint,
      status: res.status,
      ok: res.ok,
      /* 404 and 410 are the far end saying this URL will never work again:
         the app was uninstalled, or the browser rotated its keys. Anything
         else is a bad afternoon. */
      gone: res.status === 404 || res.status === 410,
      error: error || null
    };
  } catch (e) {
    /* A network failure is NOT `gone`. Pruning on it would delete every
       subscription in the account the first time DNS wobbled, and the way
       that gets discovered is nobody being told anything ever again. */
    return {
      endpoint: sub.endpoint,
      status: null,
      ok: false,
      gone: false,
      error: e && e.message ? e.message : String(e)
    };
  }
}

/* Send to every install a person has, and keep the table honest afterwards.
 *
 * Every endpoint is attempted even after one of them is dead — a fanout that
 * gave up on the first 410 would leave the phone unpushed because a laptop
 * signed in last June had been wiped. */
async function sendToUser(userId, payload) {
  if (!configured()) return { ok: false, sent: 0, gone: 0, reason: problem() || 'The user store is not configured.', results: [] };

  const subs = await listFor(userId);
  if (!subs.length) return { ok: true, sent: 0, gone: 0, results: [], reason: 'No subscriptions.' };

  const results = [];
  for (const sub of subs) results.push(await sendOne(sub, payload));

  const now = new Date().toISOString();
  for (const r of results) {
    try {
      if (r.gone) await forget(r.endpoint);
      else if (r.ok) await db.update(TABLE + '?endpoint=eq.' + enc(r.endpoint), { last_sent: now, failures: 0, last_error: null });
      else {
        const before = subs.find((s) => s.endpoint === r.endpoint);
        await db.update(TABLE + '?endpoint=eq.' + enc(r.endpoint), {
          failures: ((before && before.failures) || 0) + 1,
          last_error: r.error ? String(r.error).slice(0, 300) : ('status ' + r.status)
        });
      }
    } catch (e) {
      /* Bookkeeping must never turn a delivered push into a failed request.
         The send already happened; this is the register catching up. */
    }
  }

  return {
    ok: results.some((r) => r.ok),
    sent: results.filter((r) => r.ok).length,
    gone: results.filter((r) => r.gone).length,
    results
  };
}

module.exports = {
  configured, problem, publicKey, keys,
  urgencyFor, ttlFor,
  listFor, save, forget,
  sendOne, sendToUser
};
