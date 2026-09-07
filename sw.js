/* Cast Bridge service worker.
 *
 * Keeps the app shell available offline. Media is never cached — these are
 * other people's streams and some of them are gigabytes.
 *
 * BUILD is the only thing that makes an installed copy update. A byte-
 * identical sw.js is never re-installed by the browser, so bump this on
 * every deploy that touches index.html or anything under assets/.
 */
const BUILD = '2026-09-07.7';
const CACHE = 'cast-bridge-' + BUILD;

const SHELL = [
  '/',
  '/index.html',
  '/assets/css/neumorphism.css',
  '/assets/css/app.css',
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

/* A tap anywhere on the notification means "show me". Focus the copy that
   is already open rather than opening a second one — two Cast Bridges
   fighting over one Cast session is a worse bug than the one being
   reported. */
async function focusApp(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if ('focus' in c) {
      if (url && 'navigate' in c) { try { await c.navigate(url); } catch (e) { /* cross-origin or gone */ } }
      return c.focus();
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(url || '/');
  return null;
}

self.addEventListener('notificationclick', (e) => {
  const data = e.notification.data || {};
  const action = e.action || '';

  /* A control button acts on the running app, so it must not close the
     notification first — the page updates it a moment later with the new
     state, and a closed notification cannot be updated, it can only be
     replaced with a second one that slides in from the top. */
  if (action) {
    e.waitUntil((async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) c.postMessage({ type: 'NOTIFY_ACTION', action, tag: e.notification.tag, data });
      /* Nothing is listening. The buttons are lies without a page behind
         them, so open one — it will pick up where the session left off. */
      if (!all.length) await focusApp(data.url);
    })());
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
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  /* Draw, update or clear one. Kept deliberately dumb: the page decides
     what to say and when, because the page is the only thing that knows
     whether the television is buffering or the upload is at 40%. */
  if (data.type === 'NOTIFY_SHOW') {
    const o = data.options || {};
    self.registration.showNotification(data.title || 'Cast Bridge', o);
    return;
  }
  if (data.type === 'NOTIFY_CLOSE') {
    self.registration.getNotifications({ tag: data.tag })
      .then((list) => list.forEach((n) => n.close()));
    return;
  }
  if (data.type === 'GET_BUILD') {
    const reply = { build: BUILD };
    if (e.ports && e.ports[0]) e.ports[0].postMessage(reply);
    else if (e.source) e.source.postMessage(reply);
  }
});
