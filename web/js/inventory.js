import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// Manager/owner only -- RLS enforces this independently (v_inventory_balances masks
// average_unit_cost_cents for anyone else), this requireAuth call is just so a cashier who
// wanders here gets a clean "restricted" message instead of an empty/broken table.
//
// Stock is tracked per VARIANT (size/color/SKU), not per product -- see the
// product_variants migration -- so each row here is one variant at one location.
//
// STEP 11: a variant is "low stock" when it has a reorder_threshold set AND its quantity at
// a location is at or below it -- a variant with no threshold set never flags (silence
// means "not tracked for reordering", not "always fine"), matching admin.js's optional
// "Reorder at" field.
let rows = [];
let lowStockOnly = false;

function isLowStock(row) {
  return row.reorderThreshold != null && row.quantity_available <= row.reorderThreshold;
}

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner']);
  if (!auth) return;
  renderNav(auth.profile);

  const client = getClient();
  const [
    { data: balances, error: balErr },
    { data: variants, error: variantErr },
    { data: products, error: prodErr },
    { data: locations, error: locErr },
  ] = await Promise.all([
    client.from('v_inventory_balances').select('*'),
    client.from('product_variants').select('id, product_id, size, color, sku, reorder_threshold'),
    client.from('products').select('id, name'),
    client.from('locations').select('id, name'),
  ]);

  const firstError = balErr || variantErr || prodErr || locErr;
  if (firstError) {
    document.getElementById('inventory-error').textContent = firstError.message;
    document.getElementById('inventory-body').innerHTML = '';
    return;
  }

  const variantById = Object.fromEntries(variants.map((v) => [v.id, v]));
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const locationById = Object.fromEntries(locations.map((l) => [l.id, l]));

  rows = balances
    .map((b) => ({
      ...b,
      variant: variantById[b.variant_id],
      product: productById[variantById[b.variant_id]?.product_id],
      location: locationById[b.location_id],
      reorderThreshold: variantById[b.variant_id]?.reorder_threshold ?? null,
    }))
    .sort((a, b2) => (a.product?.name ?? '').localeCompare(b2.product?.name ?? ''));

  document.getElementById('low-stock-toggle').addEventListener('change', (e) => {
    lowStockOnly = e.target.checked;
    renderRows();
  });

  renderRows();
}

function renderRows() {
  const visible = lowStockOnly ? rows.filter(isLowStock) : rows;
  const lowStockCount = rows.filter(isLowStock).length;

  const banner = document.getElementById('low-stock-summary');
  banner.textContent = lowStockCount > 0 ? `${lowStockCount} variant${lowStockCount === 1 ? '' : 's'} at or below their reorder threshold.` : 'No variants are currently low on stock.';

  document.getElementById('inventory-body').innerHTML =
    visible
      .map((b) => {
        const variantLabel = [b.variant?.size, b.variant?.color].filter(Boolean).join(' / ') || '—';
        const low = isLowStock(b);
        return `
        <tr class="${b.needs_review ? 'needs-review' : ''}">
          <td>${b.variant?.sku ?? '—'}</td>
          <td>${b.product?.name ?? 'Unknown product'}</td>
          <td>${variantLabel}</td>
          <td>${b.location?.name ?? '—'}</td>
          <td>${b.quantity_available}${low ? ' ⚠' : ''}</td>
          <td>${formatCents(b.average_unit_cost_cents, b.currency)}</td>
          <td>${b.needs_review ? '⚠ needs review' : ''}</td>
          <td>${low ? `<a href="purchase-orders.html?variant=${b.variant_id}">Reorder</a>` : ''}</td>
        </tr>`;
      })
      .join('') || `<tr><td colspan="8">${lowStockOnly ? 'No low-stock variants.' : 'No inventory recorded yet.'}</td></tr>`;
}

init();
