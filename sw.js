// Увеличиваем версию только если меняем структуру самого SW (редко)
const CACHE = 'kuryer-v24';

// ВАЖНО: app.js здесь НЕТ! Он не кэшируется, чтобы всегда быть свежим.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(ASSETS.map(a => c.add(a).catch(() => {})))
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // POST запросы (синхронизация данных) всегда идут в сеть, мимо кэша
  if (e.request.method !== 'GET') return;

  let url;
  try { url = new URL(e.request.url); } catch (err) { return; }

  // Если запрос к чужому домену (API Google) — мимо кэша
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  e.respondWith(
    // app.js — всегда сеть: свежесть важнее скорости.
    // Без сети и без закэшированной копии отдаём index.html (приложение стартует,
    // а сохранённая смена и очередь никуда не денутся)
    (path.endsWith('app.js')
      ? fetch(e.request).catch(() =>
          caches.match('./index.html').then(res => {
            if (res) return res;
            throw new Error('No network and no cached app.js');
          })
        )
      : // Для всего остального (html, картинки) — Cache First
        caches.match(e.request).then(hit =>
          hit || fetch(e.request).catch(() => caches.match('./index.html'))
        )
    )
  );
});
