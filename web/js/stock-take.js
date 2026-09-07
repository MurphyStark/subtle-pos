import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// Any role can run a stock take at their OWN location (RLS: stock_counts_insert lets a
// cashier insert at their primary_location_id); only managers/owner can pick a different
// location. That's enforced both here (so the UI matches what will actually be allowed)
// and by RLS itself if someone bypasses the UI.
//
// Stock is tracked per VARIANT (size/color/SKU), not per product -- see the
// product_variants migration -- so a stock take counts variants, not products.
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

  try {
    const client = getClient();
    const countId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await client.from('stock_counts').insert({
      id: countId,
      location_id: currentLocationId,
      status: 'draft',
      counted_by: profile.id,
      sync_status: 'synced',
      created_at: nowIso,
    });

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
    await client.from('stock_count_items').insert(items);

    // Transitioning draft -> completed is what triggers the reconciliation (server-side
    // trigger in the real schema, mirrored in mockClient.js for demo mode) that sets
    // inventory_balances.quantity_available to exactly what was counted.
    await client.from('stock_counts').update({ status: 'completed', completed_at: nowIso }).eq('id', countId);

    const changed = items.filter((i) => i.counted_quantity !== i.system_quantity_at_count).length;
    banner.innerHTML = `<div class="status-banner ok">Stock take completed — ${changed} variant${changed === 1 ? '' : 's'} adjusted.</div>`;

    await loadCounts();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  } finally {
    completeBtn.disabled = false;
  }
}

init();
