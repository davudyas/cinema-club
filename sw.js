// Cinema Club service worker: network-first for the site's own files, so updates show up right away,
// with the last good copy as an offline fallback. Movie data, matchmaking and chat always go to the network.
const CACHE = 'cinemaclub-v5';
const SHELL = ['/', '/index.html', '/css/style.css', '/css/fonts.css', '/js/app.js', '/js/config.js', '/js/content.js', '/js/demo-data.js',
  '/js/filter.js', '/js/games.js', '/js/movies.js', '/js/net.js', '/js/sound.js', '/assets/icon-192.png', '/assets/tmdb-logo.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
