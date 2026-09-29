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
// product_variants migration. Each row here is one variant, with a stock column per
// location the viewer can see: non-owners only ever get the shop column, because the
// Warehouse is filtered out server-side (warehouse_location migration), not hidden here.
//
// STEP 11: a variant is "low stock" when it has a reorder_threshold set AND its TOTAL
// quantity across visible locations is at or below it -- a variant with no threshold set
// never flags (silence means "not tracked for reordering", not "always fine"), matching
// admin.js's optional "Reorder at" field.
let rows = [];
let locations = [];
let lowStockOnly = false;

function isLowStock(row) {
  return row.reorderThreshold != null && row.total <= row.reorderThreshold;
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
    { data: locs, error: locErr },
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

  locations = locs;
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));

  // Pivot balances (one per variant per location) into one row per variant.
  const byVariant = {};
  for (const b of balances) {
    const row = (byVariant[b.variant_id] ??= { qty: {}, costUnits: 0, costTotal: 0, anyCost: null, needsReview: false, currency: b.currency });
    row.qty[b.location_id] = b.quantity_available;
    row.needsReview ||= b.needs_review;
    row.anyCost ??= b.average_unit_cost_cents;
    if (b.average_unit_cost_cents != null && b.quantity_available > 0) {
      row.costUnits += b.quantity_available;
      row.costTotal += b.quantity_available * b.average_unit_cost_cents;
    }
  }

  rows = variants
    .filter((v) => byVariant[v.id])
    .map((v) => {
      const r = byVariant[v.id];
      return {
        variant: v,
        product: productById[v.product_id],
        qty: r.qty,
        total: Object.values(r.qty).reduce((sum, q) => sum + q, 0),
        // Quantity-weighted across locations; falls back to any location's average when
        // nothing is in stock yet.
        avgCost: r.costUnits > 0 ? Math.round(r.costTotal / r.costUnits) : r.anyCost,
        currency: r.currency,
        needsReview: r.needsReview,
        reorderThreshold: v.reorder_threshold ?? null,
      };
    })
    .sort((a, b) => (a.product?.name ?? '').localeCompare(b.product?.name ?? ''));

  document.getElementById('inventory-head').innerHTML = `
    <tr>
      <th>SKU</th><th>Product</th><th>Variant</th>
      ${locations.map((l) => `<th>${l.name}</th>`).join('')}
      ${locations.length > 1 ? '<th>Total</th>' : ''}
      <th>Avg. unit cost</th><th></th><th></th>
    </tr>`;

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

  const colspan = 6 + locations.length + (locations.length > 1 ? 1 : 0);
  document.getElementById('inventory-body').innerHTML =
    visible
      .map((r) => {
        const variantLabel = [r.variant.size, r.variant.color].filter(Boolean).join(' / ') || '—';
        const low = isLowStock(r);
        return `
        <tr class="${r.needsReview ? 'needs-review' : ''}">
          <td>${r.variant.sku ?? '—'}</td>
          <td>${r.product?.name ?? 'Unknown product'}</td>
          <td>${variantLabel}</td>
          ${locations.map((l) => `<td>${r.qty[l.id] ?? 0}${low && locations.length === 1 ? ' ⚠' : ''}</td>`).join('')}
          ${locations.length > 1 ? `<td><strong>${r.total}</strong>${low ? ' ⚠' : ''}</td>` : ''}
          <td>${formatCents(r.avgCost, r.currency)}</td>
          <td>${r.needsReview ? '⚠ needs review' : ''}</td>
          <td>${low ? `<a href="purchase-orders.html?variant=${r.variant.id}">Reorder</a>` : ''}</td>
        </tr>`;
      })
      .join('') || `<tr><td colspan="${colspan}">${lowStockOnly ? 'No low-stock variants.' : 'No inventory recorded yet.'}</td></tr>`;
}

init();
