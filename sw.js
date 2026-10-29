// Кэшируем только статику этого сайта (GET same-origin).
// POST к API всегда идёт в сеть — кэш туда не лезет.
const CACHE = 'kuryer-v2';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './576.jpeg'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  // Каждый файл кэшируем отдельно: один битый URL не срывает весь install
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(ASSETS.map(a => c.add(a).catch(() => {})))
  ));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  let url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return; // API — мимо кэша
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
