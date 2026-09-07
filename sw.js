/* Cast Bridge service worker.
 *
 * Keeps the app shell available offline. Media is never cached — these are
 * other people's streams and some of them are gigabytes.
 *
 * BUILD is the only thing that makes an installed copy update. A byte-
 * identical sw.js is never re-installed by the browser, so bump this on
 * every deploy that touches index.html or anything under assets/.
 */
const BUILD = '2026-09-07.4';
const CACHE = 'cast-bridge-' + BUILD;

const SHELL = [
  '/',
  '/index.html',
  '/assets/css/neumorphism.css',
  '/assets/css/app.css',
  '/assets/js/app.js',
  '/assets/icon.svg',
  '/assets/icon-maskable.svg',
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

  /* Shell assets: serve from cache, refresh in the background. */
  e.respondWith(
    caches.match(req).then((hit) => {
      const live = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || live;
    })
  );
});

/* The page asks what build is actually being served. Without this the footer
   can only report what was deployed, which is the number that was never in
   doubt — the useful one is what this installed copy is running. */
self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (data.type === 'GET_BUILD') {
    const reply = { build: BUILD };
    if (e.ports && e.ports[0]) e.ports[0].postMessage(reply);
    else if (e.source) e.source.postMessage(reply);
  }
});
