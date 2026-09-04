// Minimal IndexedDB wrapper: no external library, since this project has no build step.
//
// Two stores:
//  - products_cache: the last-synced product + CURRENT SELLING PRICE list (never cost --
//    a cashier's device is never given cost data to begin with, see the RLS migration), so
//    checkout can work fully offline.
//  - outbox: sales created while offline (or that failed to reach Supabase), replayed in
//    order once connectivity returns. Mirrors the shape of the server's `sync_queue` table.

const DB_NAME = 'subtle-pos';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('products_cache')) {
        db.createObjectStore('products_cache', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const store = db.createObjectStore('outbox', { keyPath: 'id' });
        store.createIndex('status', 'status');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheProducts(products) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('products_cache', 'readwrite');
    const store = t.objectStore('products_cache');
    store.clear();
    for (const p of products) store.put(p);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getCachedProducts() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('products_cache', 'readonly');
    const req = t.objectStore('products_cache').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function queueOutbox(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('outbox', 'readwrite');
    t.objectStore('outbox').put(entry);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getPendingOutbox() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('outbox', 'readonly');
    const req = t.objectStore('outbox').index('status').getAll('pending');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function countPendingOutbox() {
  const pending = await getPendingOutbox();
  return pending.length;
}

export async function markOutboxSynced(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('outbox', 'readwrite');
    const store = t.objectStore('outbox');
    const req = store.get(id);
    req.onsuccess = () => {
      const entry = req.result;
      if (entry) {
        entry.status = 'synced';
        store.put(entry);
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
