// App-shell cache only: same-origin HTML/CSS/JS so the site loads offline. Supabase API
// calls and the CDN script are deliberately left alone (`return` below) -- offline handling
// for those is the IndexedDB outbox in js/db.js + js/sync.js, not a cached HTTP response.
const CACHE_NAME = 'subtle-pos-shell-v4';
const APP_SHELL = [
  './',
  './index.html',
  './pos.html',
  './inventory.html',
  './admin.html',
  './stock-take.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/config.js',
  './js/supabaseClient.js',
  './js/mockClient.js',
  './js/auth.js',
  './js/money.js',
  './js/db.js',
  './js/sync.js',
  './js/nav.js',
  './js/pwa.js',
  './js/image.js',
  './js/receipt.js',
  './js/labels.js',
  './js/login.js',
  './js/pos.js',
  './js/inventory.js',
  './js/admin.js',
  './js/stock-take.js',
  './icons/favicon.png',
  './img/logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let Supabase/CDN requests pass through untouched

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
