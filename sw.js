// Keeps the app shell available offline; media is never cached.
const C='cb-v2';
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/index.html']))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x))))));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);
  if(u.origin===location.origin&&e.request.mode==='navigate')e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));});
