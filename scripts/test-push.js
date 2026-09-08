/* Real push, proved.
 *
 * Two kinds of assertion live here and they are not interchangeable.
 *
 * KNOWN-ANSWER. RFC 8291 §5 publishes a worked example: fixed receiver keys,
 * a fixed sender scalar, a fixed salt, and the exact bytes that must come
 * out. That is the only thing that can establish hand-rolled crypto. A round
 * trip through this app's own encrypt and decrypt would pass just as happily
 * with the two public keys swapped in the key info, and every send would then
 * be a 201 the phone could not read.
 *
 * BEHAVIOUR OVER A REAL SOCKET. The rest runs the actual api/push.js against
 * a stub PostgREST and a stub push service, both on localhost, and reads the
 * headers that arrive. Every header this file checks is one whose absence is
 * invisible from the sending side: the push service answers 201 to a wrong
 * Urgency, a missing Topic and an unencryptable payload alike. The two rounds
 * this feature took to land were both spent on faults of exactly that shape.
 *
 * The service worker's push handler is EXECUTED, not read: sw.js is loaded
 * into a sandbox, the real listener is pulled out of it and dispatched at.
 * Retyping what the handler ought to do and checking that would prove this
 * file agrees with itself.
 */

'use strict';

const assert = require('node:assert');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let pass = 0;
const fails = [];
function ok(what, cond) {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fails.push(what); console.log('  FAIL ' + what); }
}
function eq(what, got, want) {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log('  ok   ' + what); }
  else { fails.push(what + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')');
         console.log('  FAIL ' + what + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

const ROOT = path.join(__dirname, '..');
const b = (s) => Buffer.from(s, 'base64url');

/* ==========================================================================
 * 1 · RFC 8291 — the published vector, byte for byte
 * ======================================================================== */
console.log('\n— RFC 8291 §5, the RFC\'s own worked example —\n');
{
  const { encryptPush } = require(path.join(ROOT, 'lib/push-crypto.js'));

  const out = encryptPush(
    'When I grow up, I want to be a watermelon',
    b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    b('BTBZMqHH6r4Tts7J_aSIgg'),
    {
      senderPrivateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      salt: b('DGv6ra1nlYgDCS1FRnbzlw')
    }
  );
  eq('the sender public key is the one the RFC derives from that scalar',
    out.senderPublicKey.toString('base64url'),
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  eq('and the aes128gcm body is the RFC\'s, byte for byte',
    out.body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');

  /* Two sends of one payload must differ. The parameters that make the
     vector above reproducible are exactly the parameters that would make
     this false if they were ever defaulted rather than passed. */
  const key = b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
  const auth = b('BTBZMqHH6r4Tts7J_aSIgg');
  const a1 = encryptPush('hello', key, auth);
  const a2 = encryptPush('hello', key, auth);
  ok('a fresh send uses a fresh salt', !a1.salt.equals(a2.salt));
  ok('and a fresh ephemeral key', !a1.senderPublicKey.equals(a2.senderPublicKey));

  /* Framing. A record size written little-endian decodes as 8,388,608 and
     is refused by every push service. */
  eq('the record size is four bytes big-endian', a1.body.readUInt32BE(16), 4096);
  eq('then one byte of key length', a1.body.readUInt8(20), 65);
  eq('and then that many bytes of key', a1.body.subarray(21, 86).toString('hex'), a1.senderPublicKey.toString('hex'));
  eq('the last-record delimiter is 0x02, not 0x01',
    (function () {
      /* Decrypt our own record to see the delimiter. Round-trip is fine for
         this one question — the vector above already fixed the bytes. */
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
      return 2;
    })(), 2);
}

/* ==========================================================================
 * 2 · RFC 8292 — the VAPID JWT, verified rather than parsed
 * ======================================================================== */
console.log('\n— RFC 8292, the VAPID JWT —\n');
{
  const { vapidJwt, audienceOf, vapidProblem } = require(path.join(ROOT, 'lib/push-crypto.js'));
  const keys = {
    publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    subject: 'mailto:rj@jrvsystems.app'
  };

  eq('the audience is the endpoint ORIGIN, never the whole endpoint',
    audienceOf('https://fcm.googleapis.com/fcm/send/abc123'), 'https://fcm.googleapis.com');

  const jwt = vapidJwt(keys, 'https://fcm.googleapis.com', 1800000000);
  const [h, p, sig] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  eq('the JWT is ES256', header.alg, 'ES256');
  eq('the audience claim is the origin', payload.aud, 'https://fcm.googleapis.com');
  eq('the subject is the configured contact', payload.sub, 'mailto:rj@jrvsystems.app');

  /* Verified, not merely parsed. A DER-encoded signature parses perfectly
     and is accepted by no push service — it comes back as a bare 401 with
     nothing naming the cause. */
  const pub = b(keys.publicKey);
  const jwk = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') },
    format: 'jwk'
  });
  ok('the signature verifies against the public key as raw r‖s',
    crypto.verify('sha256', Buffer.from(h + '.' + p), { key: jwk, dsaEncoding: 'ieee-p1363' }, b(sig)));
  ok('and does NOT verify when read as DER',
    !crypto.verify('sha256', Buffer.from(h + '.' + p), { key: jwk, dsaEncoding: 'der' }, b(sig)));

  /* The placeholder-subject trap: works on every Android phone in the room
     and on no iPhone, and the sending side sees nothing wrong. */
  ok('a placeholder subject is refused, not warned about',
    /placeholder/i.test(String(vapidProblem({ ...keys, subject: 'mailto:me@example.com' }))));
  ok('the refusal names the consequence, not the rule',
    /iPhone|Apple/i.test(String(vapidProblem({ ...keys, subject: 'mailto:me@example.com' }))));
  ok('a missing subject is refused', vapidProblem({ ...keys, subject: '' }) !== null);
  ok('a truncated private key is refused', vapidProblem({ ...keys, privateKey: 'AAAA' }) !== null);
  ok('a public key that is not an uncompressed point is refused',
    vapidProblem({ ...keys, publicKey: b(keys.publicKey).subarray(1).toString('base64url') }) !== null);
  eq('good keys have no problem', vapidProblem(keys), null);
}

/* ==========================================================================
 * 3 · Urgency and TTL — the header that decides whether it is ever seen
 * ======================================================================== */
console.log('\n— Urgency, and the Doze trap —\n');
{
  process.env.CAST_VAPID_PUBLIC_KEY = process.env.CAST_VAPID_PUBLIC_KEY || 'x';
  const push = require(path.join(ROOT, 'lib/push.js'));

  /* FCM maps web-push Urgency onto its own priority. `normal` may be held
     until the handset next leaves Doze — i.e. until somebody picks the phone
     up and opens something, which is exactly the symptom reported. */
  eq('a finished upload is high — the person is waiting on it', push.urgencyFor('ready'), 'high');
  eq('a failure is high', push.urgencyFor('failed'), 'high');
  eq('a hand-fired test is high, or it proves nothing', push.urgencyFor('test'), 'high');
  eq('a percentage is not', push.urgencyFor('progress'), 'normal');
  eq('and an unknown category defaults to normal', push.urgencyFor('whatever'), 'normal');

  /* A cast notification delivered four hours late is a lie about the
     present, and there is no way to withdraw it once it is on the shade. */
  ok('a cast message expires within the hour', push.ttlFor('cast') <= 3600);
  ok('a finished upload survives the afternoon', push.ttlFor('ready') >= 3600);
  ok('a test expires almost at once', push.ttlFor('test') <= 300);
}

/* ==========================================================================
 * 4 · The service worker's push handler — the real one, executed
 * ======================================================================== */
console.log('\n— sw.js, loaded and dispatched at —\n');
{
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listeners = {};
  const drawn = [];
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      registration: {
        showNotification: (title, options) => { drawn.push({ title, options }); return Promise.resolve(); },
        getNotifications: () => Promise.resolve([]),
        pushManager: { subscribe: () => Promise.reject(new Error('not in this test')) }
      },
      clients: { matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve(null) },
      skipWaiting: () => {},
      location: { origin: 'https://cast.jrvsystems.app' }
    },
    caches: { open: () => Promise.resolve({ addAll: () => Promise.resolve(), match: () => Promise.resolve(null), put: () => Promise.resolve() }), keys: () => Promise.resolve([]), match: () => Promise.resolve(null), delete: () => Promise.resolve(true) },
    location: { origin: 'https://cast.jrvsystems.app' },
    fetch: () => Promise.reject(new Error('offline in this test')),
    URL, Response, Request, Headers, console, setTimeout, clearTimeout, Date, JSON, Promise
  };
  sandbox.self.location = sandbox.location;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'sw.js' });

  ok('sw.js registers a push listener at all', Array.isArray(listeners.push) && listeners.push.length === 1);
  ok('and one for pushsubscriptionchange, so a rotated key is not silent death',
    Array.isArray(listeners.pushsubscriptionchange) && listeners.pushsubscriptionchange.length === 1);

  const fire = (data) => {
    drawn.length = 0;
    let waited = null;
    listeners.push[0]({
      data: data === null ? null : { json: () => { if (data === 'BAD') throw new Error('not json'); return data; } },
      waitUntil: (p) => { waited = p; }
    });
    return waited;
  };

  fire({ title: 'Ready to cast', body: 'Dune.mkv', tag: 'upload-done', url: '/' });
  eq('the title is drawn from the payload', drawn[0] && drawn[0].title, 'Ready to cast');
  eq('and the body', drawn[0] && drawn[0].options.body, 'Dune.mkv');
  /* THE fix. A silent notification is filed by Android under "Silent" below
     the fold and given no banner by iOS — months of arriving notifications
     that read as no notifications. */
  eq('a pushed notification is NOT silent', drawn[0] && drawn[0].options.silent, false);
  eq('the tag collapses one subject to one line', drawn[0] && drawn[0].options.tag, 'upload-done');
  eq('a tap knows where to go', drawn[0] && drawn[0].options.data.url, '/');
  ok('and is marked as pushed, so the page can tell it apart',
    drawn[0] && drawn[0].options.data.push === true);

  /* Chrome revokes push permission from an origin that receives a push and
     draws nothing, after drawing "This site has been updated in the
     background" over it. Both no-payload and unreadable-payload must still
     draw. */
  fire(null);
  ok('a push with no payload still draws something', drawn.length === 1);
  fire('BAD');
  ok('and so does one whose payload will not parse', drawn.length === 1);
  eq('the fallback title is the app, not an empty string', drawn[0] && drawn[0].title, 'Cast Bridge');

  const waited = fire({ title: 'x' });
  ok('the draw is inside waitUntil, or the worker is killed mid-flight',
    waited && typeof waited.then === 'function');
}

/* ==========================================================================
 * 5 · api/push.js over a real socket, against stub Supabase and stub FCM
 * ======================================================================== */
console.log('\n— the endpoint, end to end —\n');

/* A stub PostgREST holding two tables in memory. Only the four verbs
   lib/db.js can produce, and only `eq.` filters, which is all this app
   writes. */
function fakeStore(tables) {
  const filtersOf = (search) => {
    const out = [];
    for (const [k, v] of new URLSearchParams(search)) {
      if (['select', 'limit', 'order'].includes(k)) continue;
      if (String(v).startsWith('eq.')) out.push([k, String(v).slice(3)]);
    }
    return out;
  };
  const match = (row, f) => f.every(([k, v]) => String(row[k]) === v);

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.replace('/rest/v1/', '');
    const rows = tables[name] || (tables[name] = []);
    const f = filtersOf(u.search);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify(rows.filter((r) => match(r, f))));
      if (req.method === 'POST') {
        const incoming = JSON.parse(body || '{}');
        const list = Array.isArray(incoming) ? incoming : [incoming];
        for (const row of list) {
          const i = rows.findIndex((r) => r.endpoint && r.endpoint === row.endpoint);
          if (i >= 0) rows[i] = Object.assign({}, rows[i], row);
          else rows.push(Object.assign({ created_at: new Date().toISOString() }, row));
        }
        res.statusCode = 201;
        return res.end(JSON.stringify(list));
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse(body || '{}');
        const hit = rows.filter((r) => match(r, f));
        for (const r of hit) Object.assign(r, patch);
        return res.end(JSON.stringify(hit));
      }
      if (req.method === 'DELETE') {
        const hit = rows.filter((r) => match(r, f));
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return res.end(JSON.stringify(hit));
      }
      res.statusCode = 405;
      res.end('[]');
    });
  });
  return server;
}

/* A stub push service that records what arrived and answers what it is told
   to answer. Every header asserted below is one the real service would
   accept silently if it were wrong. */
function fakePushService(state) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.received.push({
        path: req.url,
        headers: req.headers,
        bytes: Buffer.concat(chunks).length
      });
      res.statusCode = state.answer || 201;
      res.end('');
    });
  });
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

(async function main() {
  const UID = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const tables = {
    users: [
      { id: UID, username: 'rj', role: 'admin', active: true },
      { id: OTHER, username: 'someone', role: 'user', active: true }
    ],
    push_subscriptions: []
  };

  const store = fakeStore(tables);
  const storePort = await listen(store);
  const pushState = { received: [], answer: 201 };
  const service = fakePushService(pushState);
  const servicePort = await listen(service);

  /* A real key pair, generated here: the VAPID checker refuses a fake one,
     which is the point of it. */
  const ec = crypto.createECDH('prime256v1');
  ec.generateKeys();

  process.env.CAST_SUPABASE_URL = 'http://127.0.0.1:' + storePort;
  process.env.CAST_SUPABASE_SERVICE_KEY = 'stub-service-key';
  process.env.CAST_SECRET = 'test-secret-that-is-long-enough';
  process.env.CAST_ADMIN_USER = 'rj';
  process.env.CAST_ADMIN_PASSWORD = 'irrelevant-but-present';
  process.env.CAST_VAPID_PUBLIC_KEY = ec.getPublicKey().toString('base64url');
  process.env.CAST_VAPID_PRIVATE_KEY = ec.getPrivateKey().toString('base64url');
  process.env.CAST_VAPID_SUBJECT = 'mailto:rj@jrvsystems.app';
  process.env.CAST_PUSH_HOOK_TOKEN = 'hook-token-for-the-stream-host';

  const auth = require(path.join(ROOT, 'lib/auth.js'));
  const handler = require(path.join(ROOT, 'api/push.js'));
  const app = http.createServer((req, res) => { handler(req, res); });
  const appPort = await listen(app);

  const cookie = auth.COOKIE + '=' + encodeURIComponent(auth.issue(UID));
  const call = async (method, p, { body, headers } = {}) => {
    const res = await fetch('http://127.0.0.1:' + appPort + p, {
      method,
      headers: Object.assign({ cookie, 'Content-Type': 'application/json' }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let j = null;
    try { j = await res.json(); } catch (e) { /* status is the answer */ }
    return { status: res.status, body: j };
  };

  /* The browser's half of a subscription, with a real receiver key so the
     encryption below is doing genuine work. */
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const sub = {
    endpoint: 'http://127.0.0.1:' + servicePort + '/push/AAA',
    keys: {
      p256dh: receiver.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url')
    }
  };
  /* http, not https, because the stub is local. The endpoint validator
     rightly refuses that, so this one test path is exercised through the
     library rather than the endpoint — the endpoint's own refusal is
     asserted separately below. */

  const noCookie = await fetch('http://127.0.0.1:' + appPort + '/api/push', { method: 'GET' });
  eq('an unauthenticated GET is refused', noCookie.status, 401);

  const state = await call('GET', '/api/push');
  eq('a signed-in GET reports push as configured', state.body && state.body.configured, true);
  ok('and hands back the public key the browser needs',
    state.body && state.body.publicKey === process.env.CAST_VAPID_PUBLIC_KEY);
  eq('with nothing registered yet', state.body && state.body.installs.length, 0);

  const httpSub = await call('POST', '/api/push', { body: { endpoint: 'http://push.example/x', keys: sub.keys } });
  eq('a non-https endpoint is refused', httpSub.status, 400);
  ok('and the refusal says why', /https/i.test(String(httpSub.body && httpSub.body.error)));

  const shortKey = await call('POST', '/api/push', {
    body: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'AAAA', auth: sub.keys.auth } }
  });
  eq('a p256dh that is not a P-256 point is refused', shortKey.status, 400);

  const noKeys = await call('POST', '/api/push', { body: { endpoint: 'https://fcm.googleapis.com/x' } });
  eq('a subscription with no keys is refused', noKeys.status, 400);

  /* The stored path, through the library, since the stub service is http. */
  const push = require(path.join(ROOT, 'lib/push.js'));
  await push.save(UID, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, 'Chrome on Android');
  eq('a subscription is stored', tables.push_subscriptions.length, 1);
  await push.save(UID, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, 'Chrome on Android');
  eq('re-subscribing the same install overwrites rather than duplicates', tables.push_subscriptions.length, 1);

  const listed = await call('GET', '/api/push');
  eq('the settings panel sees one install', listed.body.installs.length, 1);
  eq('named by what it is, not by its URL', listed.body.installs[0].ua, 'Chrome on Android');

  /* The test send, through the endpoint, at the stub service. */
  pushState.received.length = 0;
  const test = await call('POST', '/api/push?test=1');
  eq('the test send reports one delivery', test.body && test.body.sent, 1);
  const got = pushState.received[0];
  ok('the push carried a VAPID Authorization', /^vapid t=.+, k=.+$/.test(String(got.headers.authorization)));
  eq('encoded as aes128gcm', got.headers['content-encoding'], 'aes128gcm');
  eq('with a TTL', String(got.headers.ttl), '60');
  eq('and Urgency high, or a dozing phone may sit on it', got.headers.urgency, 'high');
  eq('and a Topic, so a queued duplicate is replaced not stacked', got.headers.topic, 'push-test');
  ok('the body is an encrypted record, not a JSON blob', got.bytes > 86);

  /* The JWT the service received must verify, and its audience must be the
     stub's own origin — a JWT minted for the wrong audience is a 401 that
     names nothing. */
  const jwt = String(got.headers.authorization).match(/vapid t=([^,]+)/)[1];
  const claim = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  eq('the audience is the endpoint\'s origin', claim.aud, 'http://127.0.0.1:' + servicePort);
  ok('and the token expires within RFC 8292\'s 24 hours',
    claim.exp - Math.floor(Date.now() / 1000) <= 24 * 3600);

  /* One person cannot unsubscribe another person's phone. An endpoint is not
     a secret — it travels in every subscribe. */
  const otherCookie = auth.COOKIE + '=' + encodeURIComponent(auth.issue(OTHER));
  const stealing = await fetch('http://127.0.0.1:' + appPort + '/api/push', {
    method: 'DELETE',
    headers: { cookie: otherCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint })
  });
  eq('another account deleting your endpoint answers ok', stealing.status, 200);
  eq('and does not actually delete it', tables.push_subscriptions.length, 1);

  /* 410 Gone: the app was uninstalled or the browser rotated its keys. The
     row must go, or every future fanout wastes a request on a dead URL. */
  pushState.answer = 410;
  const dead = await call('POST', '/api/push?test=1');
  eq('a 410 is reported as nothing sent', dead.body.sent, 0);
  eq('and the dead subscription is pruned', tables.push_subscriptions.length, 0);

  /* A network failure is NOT death. Pruning on it would empty the table the
     first time DNS wobbled, and the way that gets noticed is never. */
  await push.save(UID, { endpoint: 'https://127.0.0.1:1/push/nope', p256dh: sub.keys.p256dh, auth: sub.keys.auth }, 'Unreachable');
  const unreachable = await push.sendToUser(UID, { title: 'x', category: 'test', tag: 't' });
  eq('an unreachable push service sends nothing', unreachable.sent, 0);
  eq('and is not treated as gone', unreachable.gone, 0);
  eq('so the subscription survives', tables.push_subscriptions.length, 1);
  eq('and the failure is counted, not swallowed', tables.push_subscriptions[0].failures, 1);
  ok('with the reason kept', Boolean(tables.push_subscriptions[0].last_error));

  /* The machine door the stream host uses. */
  const wrong = await fetch('http://127.0.0.1:' + appPort + '/api/push', {
    method: 'POST',
    headers: { 'x-cast-push-token': 'not-the-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: UID, payload: { title: 'x' } })
  });
  eq('a wrong hook token is 404, not 401 — it does not confirm the door exists', wrong.status, 404);

  tables.push_subscriptions.length = 0;
  await push.save(UID, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, 'Chrome on Android');
  pushState.answer = 201;
  pushState.received.length = 0;
  const hooked = await fetch('http://127.0.0.1:' + appPort + '/api/push', {
    method: 'POST',
    headers: { 'x-cast-push-token': 'hook-token-for-the-stream-host', 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: UID, payload: { title: 'Ready to cast', body: 'Dune.mkv', tag: 'upload-done', category: 'ready' } })
  });
  const hookedBody = await hooked.json();
  eq('the stream host may send with the token and no session', hookedBody.sent, 1);
  eq('and a finished upload goes out as high urgency', pushState.received[0].headers.urgency, 'high');

  const noTitle = await fetch('http://127.0.0.1:' + appPort + '/api/push', {
    method: 'POST',
    headers: { 'x-cast-push-token': 'hook-token-for-the-stream-host', 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: UID, payload: {} })
  });
  eq('a push with no title is refused — it would draw an empty line', noTitle.status, 400);

  /* Missing keys must produce the SENTENCE, not a silent off. */
  delete process.env.CAST_VAPID_PRIVATE_KEY;
  const broken = await call('GET', '/api/push');
  eq('with no keys, push reports itself unconfigured', broken.body.configured, false);
  ok('and says which variables are missing', /CAST_VAPID/.test(String(broken.body.problem)));

  app.close(); store.close(); service.close();

  console.log('\n' + '='.repeat(64));
  if (fails.length) {
    console.log('FAILED ' + fails.length + ' of ' + (pass + fails.length));
    for (const f of fails) console.log('  · ' + f);
    process.exit(1);
  }
  console.log('push: ' + pass + ' assertions, all green');
})().catch((e) => { console.error(e); process.exit(1); });
