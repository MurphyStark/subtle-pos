// App-shell cache only: same-origin HTML/CSS/JS so the site loads offline. Supabase API
// calls and the CDN script are deliberately left alone (`return` below) -- offline handling
// for those is the IndexedDB outbox in js/db.js + js/sync.js, not a cached HTTP response.
// v6: the wholesale-location removal deleted transfers.html/js/transfers.js -- caches
// .addAll() is all-or-nothing, so leaving stale entries here would make EVERY install fail
// (a single 404 aborts the whole app-shell cache), silently breaking offline support
// entirely. Added reports/activity, the newest pages.
// v7: transfers.html/js are back (owner-only Warehouse moves); mockClient.js has the full
// catalog -- the bump also forces returning devices to drop the old cached product list.
// v8: Tracy/Tanya/Admin accounts -- forces devices off the cached old login + mock.
// v9: redesign phase 1 -- new shell/styles, icons.js + ui.js, brand mark and wordmark.
const CACHE_NAME = 'subtle-pos-shell-v9';
const APP_SHELL = [
  './',
  './index.html',
  './pos.html',
  './inventory.html',
  './admin.html',
  './stock-take.html',
  './purchase-orders.html',
  './returns.html',
  './customers.html',
  './reports.html',
  './activity.html',
  './transfers.html',
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
  './js/thermal-print.js',
  './js/login.js',
  './js/pos.js',
  './js/inventory.js',
  './js/admin.js',
  './js/stock-take.js',
  './js/purchase-orders.js',
  './js/returns.js',
  './js/customers.js',
  './js/reports.js',
  './js/activity.js',
  './js/activity-page.js',
  './js/transfers.js',
  './js/icons.js',
  './js/ui.js',
  './icons/favicon.png',
  './img/logo.png',
  './img/logo-wordmark.png',
  './img/mark.png',
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
