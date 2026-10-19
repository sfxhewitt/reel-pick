/* Reel Pick service worker. Bump CACHE on every release so installed home-screen apps pick up new code. */
const CACHE = 'reelpick-v8-2026-10-19';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'tmdb.js', 'plex.js', 'reco.js', 'rules.js', 'data.js', 'config.js', 'icon-180.png', 'icon-192.png', 'manifest.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// Network-first for same-origin files (fresh code when online, cached copy offline). Cross-origin (TMDB API/images) is not intercepted.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request).then(m => m || caches.match('index.html'))));
});
