// Увеличиваем версию при КАЖДОЙ правке этого файла или кэшируемой статики
const CACHE = 'kuryer-v49';

// app.js здесь НЕТ — он грузится по сети (network-first)
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
  // POST-запросы (синхронизация) всегда в сеть, мимо кэша
  if (e.request.method !== 'GET') return;

  let url;
  try { url = new URL(e.request.url); } catch (err) { return; }

  // Чужие домены — мимо кэша
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // HTML и JS — всегда сеть: свежесть важнее скорости.
  // Свежий ответ кладём в кэш как офлайн-запас; при отсутствии сети — кэш
  if (path === '/' || path.endsWith('/') || path.endsWith('index.html') || path.endsWith('app.js')) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() =>
        caches.match(e.request).then(hit => {
          if (hit) return hit;
          // Честная ошибка вместо подмены: HTML нельзя отдавать как JS
          throw new Error('Нет сети и нет кэша: ' + path);
        })
      )
    );
    return;
  }

  // Остальное (картинки, манифест) — Cache First
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).catch(() => new Response('', { status: 504 }))
    )
  );
});
