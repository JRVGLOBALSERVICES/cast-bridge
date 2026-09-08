/* Cast Bridge service worker.
 *
 * Keeps the app shell available offline. Media is never cached — these are
 * other people's streams and some of them are gigabytes.
 *
 * BUILD is the only thing that makes an installed copy update. A byte-
 * identical sw.js is never re-installed by the browser, so bump this on
 * every deploy that touches index.html or anything under assets/.
 */
const BUILD = '2026-09-08.1';
const CACHE = 'cast-bridge-' + BUILD;

const SHELL = [
  '/',
  '/index.html',
  '/assets/css/neumorphism.css',
  '/assets/css/app.css',
  '/assets/js/artwork.js',
  '/assets/js/sources.js',
  '/assets/js/castaction.js',
  '/assets/js/resume.js',
  '/assets/js/qr.js',
  '/assets/js/app.js',
  '/assets/icon.svg',
  '/assets/icon-maskable.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-192.png',
  '/assets/icon-maskable-512.png',
  '/assets/apple-touch-icon.png',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // streams, fonts, cast SDK
  if (url.pathname.startsWith('/api/')) return;    // scans are always live

  /* Navigations: network first, fall back to the cached shell offline. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  /* Shell assets: network first, cache only as the offline fallback.
   *
   * This was cache-first with a background refresh, and that pairs a FRESH
   * index.html (navigations are network-first) with the PREVIOUS build's
   * app.css and app.js on the first launch after every deploy. Not merely
   * stale — mismatched, which is how a shipped layout fix can be invisible
   * on the phone and present everywhere else. The stale copy only ever
   * appears now when the network genuinely fails. */
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

/* ------------------------------------------------------------------ *
 * Notifications
 *
 * Everything here is a LOCAL notification: the page asks the worker to
 * draw one, and the worker hands a tap back to the page. There is no push
 * server and no subscription, on purpose — a bridge between a phone and a
 * television has nothing to say when the phone is not running, and asking
 * for push permission to say nothing is how an app earns a permanent
 * "Blocked" in the browser's settings.
 *
 * The worker draws them rather than the page because a page that has been
 * backgrounded is exactly when they matter, and because `Notification`
 * actions — the Pause and Stop buttons in the shade — only exist on a
 * worker registration. `window.Notification` cannot carry them.
 * ------------------------------------------------------------------ */

/* A tap anywhere on the notification means "show me".
 *
 * Focus the copy that is already open rather than opening a second one —
 * two Cast Bridges fighting over one Cast session is a worse bug than the
 * one being reported.
 *
 * It used to `navigate()` that client to the notification's url first, and
 * that is why a tap read as "the notification just disappears". Two faults
 * in one line: navigating an OPEN window is a full reload, which drops the
 * Cast sender the notification is reporting on; and per spec the client
 * reference is spent by the navigation, so the `focus()` that followed
 * could reject and leave a closed notification and no window. Focus is the
 * whole job for a window that exists. The url is only used to decide what
 * to open when there is nothing to focus. */
async function focusApp(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if ('focus' in c) {
      try { return await c.focus(); } catch (e) { /* gone between listing and focusing */ }
    }
  }
  if (self.clients.openWindow) {
    try { return await self.clients.openWindow(url || '/'); } catch (e) { return null; }
  }
  return null;
}

/* ---- The buttons in the shade ----------------------------------------
 *
 * Pause and Stop cannot be performed here. The Cast session lives in the
 * page's SDK and the <video> element lives in the page, so this worker can
 * only ever be a courier: it hands the tap to a page and the page acts.
 *
 * The bug that made them do nothing was treating "a window client exists"
 * as "a page is listening". Neither half holds on a phone. The app is
 * usually not running at all when the notification matters — the previous
 * version opened the app and dropped the tap on the floor — and Android
 * freezes a backgrounded PWA within minutes, so postMessage to it is
 * QUEUED, not delivered, and the film carries on playing while the shade
 * says it was paused.
 *
 * So a tap is delivered, waited on for an acknowledgement, and if none
 * comes it is written down and the app is opened to perform it on wake.
 * Every tap carries an id and the page refuses an id twice, because the
 * frozen page WILL thaw and process its queued copy as well. */
const ACTION_TTL = 90000;            // older than this and it is not what they meant
/* A live page answers in single-digit milliseconds, so this only ever
   governs how long a FROZEN one is waited on before the app is brought up.
   It was 1500. Chrome grants a notificationclick a limited window in which
   a worker is allowed to focus or open a window, and every millisecond spent
   waiting on a page that is never going to answer is spent out of that
   allowance. Short enough to leave it intact, long enough that a page merely
   busy with a repaint is not given up on. */
const ACK_MS = 600;
const PENDING_KEY = '/__pending-action';
const LOG_KEY = '/__action-log';
const LOG_MAX = 12;

let seq = 0;
function actionId() {
  seq += 1;
  return Date.now().toString(36) + '-' + seq;
}

/* Written to the cache, not to a variable: this worker can be shut down
   between opening the app and the app booting, and a tap that survives
   only in memory is the same dropped tap with more steps. */
async function writePending(job) {
  try {
    const c = await caches.open(CACHE);
    await c.put(new Request(PENDING_KEY),
      new Response(JSON.stringify(job), { headers: { 'content-type': 'application/json' } }));
  } catch (e) { /* storage refused; the app opening is still the right outcome */ }
}

async function takePending() {
  try {
    const c = await caches.open(CACHE);
    const hit = await c.match(PENDING_KEY);
    if (!hit) return null;
    await c.delete(PENDING_KEY);
    const job = await hit.json();
    if (!job || typeof job.at !== 'number') return null;
    if (Date.now() - job.at > ACTION_TTL) return null;   // stale: they moved on
    return job;
  } catch (e) { return null; }
}

async function clearPending(id) {
  const job = await takePending();
  if (job && job.id !== id) await writePending(job);     // not the one acknowledged
}

/* What happened to the last few taps.
 *
 * A shade button that does nothing is the hardest kind of fault to see:
 * it happens on a handset, in another app, with no console attached, and
 * every party to it — the worker, the page, the television — can fail
 * silently and separately. Guessing at which one from a description has
 * already cost three attempts.
 *
 * So each tap writes down the road it took, the page writes down what it
 * managed to do with it, and the Notifications setting says the answer in
 * one sentence. It is a user-facing line, not a debug dump: "the app had
 * it, but the television could not be reached" is the difference between
 * a broken app and a television that has been switched off, and the person
 * holding the phone is owed that either way.
 *
 * It lives in CACHE, so an update clears it. That is the right trade — a
 * trace from a build that is no longer installed explains nothing. */
async function trace(entry) {
  try {
    const c = await caches.open(CACHE);
    const hit = await c.match(LOG_KEY);
    const list = hit ? await hit.json() : [];
    list.unshift(entry);
    await c.put(new Request(LOG_KEY),
      new Response(JSON.stringify(list.slice(0, LOG_MAX)),
        { headers: { 'content-type': 'application/json' } }));
  } catch (e) { /* a trace that cannot be written must never break the tap */ }
}

/* The page reporting back on a tap the worker had already logged. Matched
   by id rather than appended, so one tap is one line however many roads it
   travelled down. */
async function traceResult(id, outcome) {
  try {
    const c = await caches.open(CACHE);
    const hit = await c.match(LOG_KEY);
    if (!hit) return;
    const list = await hit.json();
    const row = list.find((e) => e && e.id === id);
    if (!row || row.outcome) return;          // first answer wins; a replay is not a second tap
    row.outcome = outcome;
    await c.put(new Request(LOG_KEY),
      new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } }));
  } catch (e) { /* as above */ }
}

/* One client, one channel, one answer. Resolves false on silence rather
   than hanging, because silence is the case this exists to handle. */
function askClient(client, msg) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let ch = null;
    try { ch = new MessageChannel(); } catch (e) { ch = null; }
    if (ch) {
      ch.port1.onmessage = (ev) => {
        const d = ev.data || {};
        finish(d.type === 'NOTIFY_ACTION_ACK' && d.id === msg.id);
      };
    }
    try { client.postMessage(msg, ch ? [ch.port2] : undefined); } catch (e) { finish(false); }
    setTimeout(() => finish(false), ACK_MS);
  });
}

async function deliverAction(action, tag, data) {
  const msg = { type: 'NOTIFY_ACTION', id: actionId(), action, tag, data };
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  const acked = all.length
    ? (await Promise.all(all.map((c) => askClient(c, msg)))).some(Boolean)
    : false;
  if (acked) {
    await trace({ id: msg.id, at: Date.now(), action, tag, route: 'page', woke: false });
    return;
  }

  /* Nobody answered. Write it down and bring the app up — on boot, and on
     every return to the foreground, it asks for this and runs it against a
     live Cast session. */
  await writePending({ id: msg.id, action, tag, data, at: Date.now() });
  const win = await focusApp(data && data.url);
  await trace({ id: msg.id, at: Date.now(), action, tag, route: 'written-down', woke: Boolean(win) });
}

self.addEventListener('notificationclick', (e) => {
  const data = e.notification.data || {};
  const action = e.action || '';

  /* A control button acts on the running app, so it must not close the
     notification first — the page updates it a moment later with the new
     state, and a closed notification cannot be updated, it can only be
     replaced with a second one that slides in from the top. */
  if (action) {
    e.waitUntil(deliverAction(action, e.notification.tag, data));
    return;
  }

  e.notification.close();
  e.waitUntil(focusApp(data.url));
});

/* A notification the person swiped away is a preference, not an accident.
   The page hears about it so it stops re-drawing the same one on the next
   progress tick. */
self.addEventListener('notificationclose', (e) => {
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) c.postMessage({ type: 'NOTIFY_CLOSED', tag: e.notification.tag });
  })());
});

/* The page asks what build is actually being served. Without this the footer
   can only report what was deployed, which is the number that was never in
   doubt — the useful one is what this installed copy is running. */
self.addEventListener('message', (e) => {
  const data = e.data || {};
  const reply = (msg) => {
    if (e.ports && e.ports[0]) e.ports[0].postMessage(msg);
    else if (e.source) e.source.postMessage(msg);
  };

  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  /* Draw, update or clear one. Kept deliberately dumb: the page decides
     what to say and when, because the page is the only thing that knows
     whether the television is buffering or the upload is at 40%. */
  if (data.type === 'NOTIFY_SHOW') {
    const o = data.options || {};
    self.registration.showNotification(data.title || 'Cast Bridge', o);
    return;
  }
  /* One subject, or the lot. The tagless form is what a page sends when it
     comes to the front: everything in the shade is about a screen the
     person is now looking at, including anything drawn by a PREVIOUS
     instance of this app — which the fresh one has no record of and could
     not otherwise clear. */
  if (data.type === 'NOTIFY_CLOSE') {
    const filter = data.tag ? { tag: data.tag } : undefined;
    self.registration.getNotifications(filter)
      .then((list) => list.forEach((n) => n.close()));
    return;
  }
  /* A page that thawed and performed its queued copy, so the written-down
     one must not fire a second time. */
  if (data.type === 'NOTIFY_ACTION_ACK') {
    e.waitUntil ? e.waitUntil(clearPending(data.id)) : clearPending(data.id);
    return;
  }
  /* The page saying what it actually managed to do with a tap — which is a
     different question from whether it received one, and the only question
     worth asking when a button appears to do nothing. */
  if (data.type === 'NOTIFY_ACTION_RESULT') {
    const p = traceResult(data.id, data.outcome);
    if (e.waitUntil) e.waitUntil(p);
    return;
  }
  if (data.type === 'GET_ACTION_LOG') {
    caches.open(CACHE)
      .then((c) => c.match(LOG_KEY))
      .then((hit) => (hit ? hit.json() : []))
      .then((list) => reply({ type: 'ACTION_LOG', list: list || [] }))
      .catch(() => reply({ type: 'ACTION_LOG', list: [] }));
    return;
  }
  /* Asked on boot: "was a button tapped while I was not running?" */
  if (data.type === 'GET_PENDING_ACTION') {
    takePending().then((job) => reply({ type: 'PENDING_ACTION', job: job || null }));
    return;
  }
  if (data.type === 'GET_BUILD') reply({ build: BUILD });
});


/* ==========================================================================
 * REAL PUSH — the half a page cannot do
 *
 * Everything above this line is a LOCAL notification: a running page asks,
 * the worker draws. That covers a backgrounded app and nothing else. The
 * phone freezes a tab it has not seen for a while, and a closed app is not
 * running at all, and those are most of the moments a notification would
 * have been worth having. Rj, twice: "I still can't see background
 * notifications on the cast."
 *
 * A push is delivered to the browser, and the browser STARTS this worker to
 * draw it. There does not have to be a page.
 * ======================================================================== */

/* Chrome will not let a push be received silently: a worker that returns
   without calling showNotification gets "This site has been updated in the
   background" drawn over it, and repeatedly doing so costs the origin its
   push permission. So every branch here draws something, including the
   branch where the payload was unreadable — an honest "something happened"
   beats a browser-authored notice about a site being updated. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }

  const title = d.title || 'Cast Bridge';
  const tag = d.tag || 'cast';
  const options = {
    body: d.body || '',
    tag: tag,
    icon: d.art || '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    /* NOT silent. This is the whole point of the exercise: a silent
       notification is filed by Android under "Silent" below the fold and
       given no banner at all by iOS, which is how months of working
       notifications read as broken ones. The page's local path still uses
       the tag to keep an update quiet — see notify.options() in app.js —
       but a push only ever fires for something worth saying once. */
    silent: false,
    renotify: false,
    requireInteraction: Boolean(d.ongoing),
    data: { url: d.url || '/', tag: tag, push: true }
  };
  if (d.art) options.image = d.art;
  if (d.actions && d.actions.length) options.actions = d.actions.slice(0, 2);

  /* waitUntil, and the promise must be the showNotification one. Returning
     early ends the worker's permitted lifetime and the draw is cancelled
     mid-flight, which looks exactly like a push that never arrived. */
  e.waitUntil(self.registration.showNotification(title, options));
});

/* The browser rotated this install's keys, or the subscription expired.
 *
 * When this fires the OLD endpoint is already dead — every send to it will
 * answer 410 — and the app may not be opened for a week. Re-subscribing here
 * and telling the server is the only thing standing between a key rotation
 * and a phone that quietly stops receiving anything, with nothing anywhere
 * reporting a fault.
 *
 * `e.oldSubscription` is not universally populated, so the server is asked
 * to forget the old endpoint only when there is one to name; the fanout
 * prunes on 410 regardless, so a missed delete costs one wasted send. */
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription || null;
    let key = null;
    try {
      const res = await fetch('/api/push', { credentials: 'include' });
      const j = await res.json();
      key = j && j.publicKey;
    } catch (err) { /* offline: the app re-subscribes on its next boot */ }
    if (!key) return;

    try {
      const fresh = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key
      });
      await fetch('/api/push', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fresh.toJSON ? fresh.toJSON() : fresh)
      });
      if (old && old.endpoint) {
        await fetch('/api/push', {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: old.endpoint })
        }).catch(() => {});
      }
    } catch (err) { /* nothing more this worker can do without a page */ }
  })());
});
