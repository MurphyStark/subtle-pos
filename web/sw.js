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
// v10: redesign phase 2 -- stock take wizard/history/report, product and variant pages.
// v11: network-first fetch so a new deploy shows up on the next load.
// v12: My Profile page.
// v13: review fixes -- images cache-first, smaller photos, local-date reports, cart kept.
const CACHE_NAME = 'subtle-pos-shell-v13';
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
  './stock-takes.html',
  './stock-take-report.html',
  './product.html',
  './variant.html',
  './profile.html',
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
  './js/catalog.js',
  './js/stock-takes.js',
  './js/stock-take-report.js',
  './js/product.js',
  './js/variant.js',
  './js/profile.js',
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

  // Product photos and icons rarely change (a new photo gets a new file name), so serve them
  // from the cache once fetched -- saves mobile data and stops tiles loading grey each time.
  if (event.request.method === 'GET' && /\.(jpe?g|png|webp|svg)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ??
          fetch(event.request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
      )
    );
    return;
  }

  // Network first, cache as the offline fallback: when online you always get the latest
  // deploy (a cache-first shell kept showing the previous version after an update until a
  // second reload); when offline the last good copy is served.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? Response.error()))
  );
});
