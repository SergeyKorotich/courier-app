// Кэшируем только статику этого сайта (GET same-origin).
// POST к API всегда идёт в сеть — кэш туда не лезет.
const CACHE = 'kuryer-v12';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
// Эти файлы меняются при каждом релизе — отдаём из сети, кэш как запасной вариант
const VOLATILE = [/\/index\.html$/, /\/app\.js$/, /\/$/];

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

  const path = url.pathname;
  const volatile = VOLATILE.some(re => re.test(path));

  e.respondWith(
    (volatile
      ? // network-first: свежая версия важнее мгновенной загрузки
        fetch(e.request).then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        }).catch(() => caches.match(e.request)
            .then(hit => hit || caches.match('./index.html')))
      : // cache-first: иконка, manifest и прочая неизменяемая статика
        caches.match(e.request).then(hit => hit || fetch(e.request))
    )
  );
});
