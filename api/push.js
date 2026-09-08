/* GET    /api/push        -> can this account be pushed to, and from where
 * POST   /api/push        -> register this browser's subscription
 * POST   /api/push?test=1 -> send one to this account, now, and say what happened
 * DELETE /api/push        -> forget this browser
 *
 * Plus one machine door, at the bottom: the stream host asking for a push to
 * be sent on somebody's behalf. It carries a shared secret, not a session,
 * because a box finishing an upload at 3am has no cookie.
 *
 * ── WHY A TEST SEND IS AN ENDPOINT AND NOT A SCRIPT ─────────────────────
 *
 * The last two attempts at this ended the same way: the code was right, and
 * whether it reached the handset was unknowable from here. Permission state,
 * whether the app is installed, whether Android has been told to keep it
 * quiet — none of that is visible to a server, and every one of them looks
 * identical to a bug from the outside. So the diagnostic belongs on the
 * phone: a button in the Notifications row that fires a real push through
 * the real path and reports back what each install answered. If it says
 * `201` and nothing appeared, the fault is in the operating system's
 * settings; if it says nothing is registered, it is this app's fault. Those
 * are different problems and the app should not make somebody guess which.
 *
 * The isolation rule, same as history and now-playing: which rows this
 * touches is decided from the signed session. The endpoint is a URL that can
 * wake somebody's phone, so a browser is never allowed to name whose it is.
 */

const auth = require('../lib/auth');
const push = require('../lib/push');

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    /* A subscription is under a kilobyte. 8 KB is generous and short of
       anything worth storing. */
    if (total > 8192) { const e = new Error('Too much data.'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    const err = new Error('That request was not readable.');
    err.status = 400;
    throw err;
  }
}

function fail(res, status, error) {
  res.statusCode = status;
  res.end(JSON.stringify({ ok: false, error }));
}

function params(req) {
  if (req.query) return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  } catch (e) {
    return {};
  }
}

/* A subscription as the browser hands it over, checked rather than trusted.
   An endpoint that is not https is not a push service, and a p256dh that is
   not 65 bytes cannot be a P-256 point — both would be stored happily and
   then fail on every send with an error that names neither. */
function readSubscription(body) {
  const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const k = (body && body.keys) || {};
  const p256dh = typeof k.p256dh === 'string' ? k.p256dh.trim() : '';
  const secret = typeof k.auth === 'string' ? k.auth.trim() : '';

  if (!endpoint) return { error: 'No endpoint in that subscription.' };
  let url;
  try { url = new URL(endpoint); } catch (e) { return { error: 'That endpoint is not an address.' }; }
  if (url.protocol !== 'https:') return { error: 'A push endpoint has to be https.' };
  if (endpoint.length > 2000) return { error: 'That endpoint is implausibly long.' };
  if (!p256dh || !secret) return { error: 'That subscription carries no keys, so nothing could be encrypted for it.' };
  try {
    if (Buffer.from(p256dh, 'base64url').length !== 65) return { error: 'The p256dh key is not a 65-byte P-256 point.' };
    if (Buffer.from(secret, 'base64url').length !== 16) return { error: 'The auth secret is not 16 bytes.' };
  } catch (e) {
    return { error: 'Those keys are not base64url.' };
  }
  return { sub: { endpoint, p256dh, auth: secret } };
}

/* What the settings panel is told. Deliberately includes the REASON push is
   unavailable when it is: "off" with no explanation is the state that got
   this app two rounds of being told it was broken. */
function describe(subs) {
  return subs.map((s) => ({
    endpoint: s.endpoint,
    ua: s.ua || null,
    created_at: s.created_at,
    last_sent: s.last_sent || null,
    failures: s.failures || 0,
    last_error: s.last_error || null
  }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  /* ---- the machine door -------------------------------------------------
     The stream host has no session. It presents a shared secret and the uid
     it read out of a signed ticket, and asks for one push. Checked before
     the session guard because it is a different kind of caller, not a weaker
     one — and it can only ever SEND, never read or delete a subscription. */
  const hook = req.headers['x-cast-push-token'];
  if (hook) {
    const want = (process.env.CAST_PUSH_HOOK_TOKEN || '').trim();
    if (!want) return fail(res, 503, 'No push hook is configured on this deployment.');
    /* Length-checked before compare so a wrong-length token cannot be told
       apart by timing from a wrong-value one. */
    const a = Buffer.from(String(hook));
    const b = Buffer.from(want);
    const okToken = a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
    if (!okToken) return fail(res, 404, 'Not found.');
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');

    let body;
    try { body = await readJson(req); } catch (e) { return fail(res, e.status || 400, e.message); }
    const uid = body && typeof body.uid === 'string' ? body.uid.trim() : '';
    if (!/^[0-9a-f-]{8,64}$/i.test(uid)) return fail(res, 400, 'That is not a user id.');
    const payload = (body && body.payload) || {};
    if (!payload.title) return fail(res, 400, 'A push with no title draws nothing.');

    try {
      const out = await push.sendToUser(uid, {
        title: String(payload.title).slice(0, 120),
        body: payload.body ? String(payload.body).slice(0, 300) : '',
        tag: payload.tag ? String(payload.tag).slice(0, 32) : 'cast',
        category: payload.category || 'ready',
        url: typeof payload.url === 'string' ? payload.url : '/',
        art: typeof payload.art === 'string' ? payload.art : null
      });
      res.statusCode = 200;
      return res.end(JSON.stringify(out));
    } catch (e) {
      return fail(res, e.status || 500, e.message || 'That push could not be sent.');
    }
  }

  const me = await auth.guard(req, res);
  if (!me) return;

  const q = params(req);

  try {
    if (req.method === 'GET') {
      const problem = push.problem();
      const subs = problem ? [] : await push.listFor(me.id);
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        configured: problem === null,
        /* The sentence, not a boolean. See the header. */
        problem: problem,
        publicKey: push.publicKey(),
        installs: describe(subs)
      }));
    }

    if (req.method === 'POST') {
      const problem = push.problem();
      if (problem) return fail(res, 503, problem);

      /* The test send. Nothing is registered from this request — it fires at
         whatever this account already has, which is the point: it answers
         "does a push from the server reach my phone", not "does this request
         work". */
      if (q.test === '1' || q.test === 'true') {
        const out = await push.sendToUser(me.id, {
          title: 'Cast Bridge',
          body: 'Push works. This one came from the server, not the app.',
          tag: 'push-test',
          category: 'test',
          url: '/'
        });
        res.statusCode = 200;
        return res.end(JSON.stringify(Object.assign({ ok: true }, out, {
          /* Named separately from `sent` because zero installs and zero
             successful sends are different faults with different fixes. */
          installs: out.results ? out.results.length : 0
        })));
      }

      let body;
      try { body = await readJson(req); } catch (e) { return fail(res, e.status || 400, e.message); }
      const read = readSubscription(body);
      if (read.error) return fail(res, 400, read.error);

      await push.save(me.id, read.sub, req.headers['user-agent']);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, endpoint: read.sub.endpoint }));
    }

    if (req.method === 'DELETE') {
      let body;
      try { body = await readJson(req); } catch (e) { return fail(res, e.status || 400, e.message); }
      const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
      if (!endpoint) return fail(res, 400, 'Which endpoint?');

      /* Pinned to this account. Without the user_id in the filter, anyone
         signed in could unsubscribe anybody else's phone by naming its
         endpoint — and an endpoint is not a secret, it travels in every
         subscribe. */
      const mine = await push.listFor(me.id);
      if (!mine.some((s) => s.endpoint === endpoint)) {
        /* Already gone, or never this account's. Both are "there is nothing
           here for you", and answering ok keeps a re-tap from erroring. */
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, removed: 0 }));
      }
      await push.forget(endpoint);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, removed: 1 }));
    }

    return fail(res, 405, 'Method not allowed.');
  } catch (e) {
    return fail(res, e.status || 500, e.message || 'That did not work.');
  }
};
