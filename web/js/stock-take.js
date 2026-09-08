import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { queueOutbox, countPendingOutbox } from './db.js';
import { initSyncListeners, replayOutbox } from './sync.js';
import { logActivity } from './activity.js';

// Any role can run a stock take at their OWN location (RLS: stock_counts_insert lets a
// cashier insert at their primary_location_id); only managers/owner can pick a different
// location. That's enforced both here (so the UI matches what will actually be allowed)
// and by RLS itself if someone bypasses the UI.
//
// Stock is tracked per VARIANT (size/color/SKU), not per product -- see the
// product_variants migration -- so a stock take counts variants, not products.
//
// Offline-capable, same pattern as checkout: if the write fails (or the device is already
// offline), the whole completed count queues in IndexedDB and replays once connectivity
// returns (see js/sync.js's pushStockCount) -- a stock take on the shop floor shouldn't be
// blocked by a dead connection any more than a sale should.
let profile = null;
let locations = [];
let currentLocationId = null;
let rows = []; // [{ variant, productName, systemQty }]

async function init() {
  registerServiceWorker();

  const auth = await requireAuth();
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  const client = getClient();
  const { data: locs } = await client.from('locations').select('id, name');
  locations = locs ?? [];

  const isManager = profile.role !== 'cashier';
  const select = document.getElementById('location-select');
  select.innerHTML = locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  currentLocationId = profile.primary_location_id ?? locations[0]?.id;
  select.value = currentLocationId;
  select.disabled = !isManager;
  select.addEventListener('change', () => {
    currentLocationId = select.value;
    loadCounts();
  });

  document.getElementById('complete-btn').addEventListener('click', completeStockTake);

  initSyncListeners(refreshStatusBanner);
  window.addEventListener('online', refreshStatusBanner);
  window.addEventListener('offline', refreshStatusBanner);
  await refreshStatusBanner();

  await loadCounts();
}

async function loadCounts() {
  const client = getClient();
  const [{ data: variants }, { data: products }, { data: balances }] = await Promise.all([
    client.from('product_variants').select('id, product_id, size, color, sku').eq('is_active', true),
    client.from('products').select('id, name'),
    client.from('v_inventory_balances').select('variant_id, location_id, quantity_available').eq('location_id', currentLocationId),
  ]);

  const productById = Object.fromEntries((products ?? []).map((p) => [p.id, p]));
  const qtyByVariant = Object.fromEntries((balances ?? []).map((b) => [b.variant_id, b.quantity_available]));

  rows = (variants ?? [])
    .map((v) => ({
      variant: v,
      productName: productById[v.product_id]?.name ?? 'Unknown product',
      systemQty: qtyByVariant[v.id] ?? 0,
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName) || (a.variant.sku ?? '').localeCompare(b.variant.sku ?? ''));

  renderRows();
}

function renderRows() {
  const container = document.getElementById('stock-take-body');
  const header = `
    <div class="stock-take-row" style="font-weight: 600; font-size: 0.85rem; color: var(--text-muted);">
      <div>Product / variant</div><div>System qty</div><div>Counted qty</div>
    </div>`;

  container.innerHTML =
    header +
    rows
      .map((r) => {
        const variantLabel = [r.variant.size, r.variant.color].filter(Boolean).join(' / ');
        return `
      <div class="stock-take-row" data-id="${r.variant.id}">
        <div>${r.productName}${variantLabel ? ` — ${variantLabel}` : ''} <span style="color: var(--text-muted); font-size: 0.8rem;">(${r.variant.sku})</span></div>
        <div>${r.systemQty}</div>
        <div>
          <input type="number" min="0" step="1" class="counted-input" value="${r.systemQty}" />
          <span class="variance-flag"></span>
        </div>
      </div>`;
      })
      .join('');

  container.querySelectorAll('.stock-take-row[data-id]').forEach((rowEl) => {
    const id = rowEl.dataset.id;
    const row = rows.find((r) => r.variant.id === id);
    const input = rowEl.querySelector('.counted-input');
    const flag = rowEl.querySelector('.variance-flag');
    const updateFlag = () => {
      const variance = Number(input.value || 0) - row.systemQty;
      flag.textContent = variance === 0 ? '' : variance > 0 ? `+${variance}` : `${variance}`;
      flag.className = 'variance-flag ' + (variance > 0 ? 'over' : variance < 0 ? 'under' : '');
    };
    input.addEventListener('input', updateFlag);
  });

  document.getElementById('complete-btn').disabled = rows.length === 0;
}

async function completeStockTake() {
  const errorEl = document.getElementById('stock-take-error');
  const banner = document.getElementById('status-banner');
  errorEl.textContent = '';
  const completeBtn = document.getElementById('complete-btn');
  completeBtn.disabled = true;

  const countId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const container = document.getElementById('stock-take-body');
  const items = rows.map((r) => {
    const input = container.querySelector(`.stock-take-row[data-id="${r.variant.id}"] .counted-input`);
    return {
      id: crypto.randomUUID(),
      stock_count_id: countId,
      variant_id: r.variant.id,
      counted_quantity: Number(input.value || 0),
      system_quantity_at_count: r.systemQty,
    };
  });
  const stockCount = {
    id: countId,
    location_id: currentLocationId,
    status: 'draft',
    counted_by: profile.id,
    sync_status: 'synced',
    created_at: nowIso,
    completed_at: nowIso,
  };

  try {
    if (navigator.onLine) {
      const client = getClient();
      const { error: countError } = await client.from('stock_counts').insert(stockCount);
      if (countError) throw countError;
      const { error: itemsError } = await client.from('stock_count_items').insert(items);
      if (itemsError) throw itemsError;
      // Transitioning draft -> completed is what triggers the reconciliation (server-side
      // trigger in the real schema, mirrored in mockClient.js for demo mode) that sets
      // inventory_balances.quantity_available to exactly what was counted.
      const { error: statusError } = await client
        .from('stock_counts')
        .update({ status: 'completed', completed_at: nowIso })
        .eq('id', countId);
      if (statusError) throw statusError;
    } else {
      throw new Error('offline'); // fall through to the offline queue below
    }
  } catch (err) {
    await queueOutbox({
      id: countId,
      entity_type: 'stock_count',
      entity_id: countId,
      status: 'pending',
      created_at: nowIso,
      payload: { stockCount, items },
    });
  }

  const changed = items.filter((i) => i.counted_quantity !== i.system_quantity_at_count).length;
  banner.innerHTML = `<div class="status-banner ok">Stock take completed — ${changed} variant${changed === 1 ? '' : 's'} adjusted.</div>`;

  await logActivity(
    profile,
    'stock_change',
    `${profile.full_name} completed a stock take (${changed} variant${changed === 1 ? '' : 's'} adjusted)`,
    { stock_count_id: countId, location_id: currentLocationId, changed_count: changed }
  );

  await loadCounts();
  await refreshStatusBanner();
  replayOutbox(refreshStatusBanner);
  completeBtn.disabled = false;
}

async function refreshStatusBanner() {
  const pending = await countPendingOutbox();
  if (pending === 0) return; // don't stomp the "stock take completed" message with an empty banner
  const banner = document.getElementById('status-banner');
  if (!navigator.onLine) {
    banner.innerHTML = `<div class="status-banner offline">Offline — ${pending} stock take${pending === 1 ? '' : 's'} queued and will sync once you're back online.</div>`;
  } else {
    banner.innerHTML = `<div class="status-banner pending">Syncing ${pending} queued stock take${pending === 1 ? '' : 's'}…</div>`;
  }
}

init();
