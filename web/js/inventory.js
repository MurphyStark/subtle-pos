import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { statCard, stockStatus, stockPill, thumb, renderPagination } from './ui.js';

// Manager/owner only -- RLS enforces this independently (v_inventory_balances masks
// average_unit_cost_cents for anyone else), this requireAuth call is just so a cashier who
// wanders here gets a clean "restricted" message instead of an empty/broken table.
//
// Stock is tracked per VARIANT (size/color/SKU), not per product -- see the
// product_variants migration. Each row here is one variant, with a stock column per
// location the viewer can see: only the admin gets a Warehouse column, because the
// Warehouse is filtered out server-side (warehouse_location migration), not hidden here.
//
// A variant's status is judged on its TOTAL across visible locations: "Low stock" at or
// below its reorder_threshold (or the shared default when it has none -- see ui.js), "Out
// of stock" at zero.
let rows = [];
let locations = [];
const view = { term: '', category: '', status: '', page: 1 };

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner', 'admin']);
  if (!auth) return;
  renderNav(auth.profile);

  const client = getClient();
  const [
    { data: balances, error: balErr },
    { data: variants, error: variantErr },
    { data: products, error: prodErr },
    { data: locs, error: locErr },
    { data: categories },
  ] = await Promise.all([
    client.from('v_inventory_balances').select('*'),
    client.from('product_variants').select('id, product_id, size, color, sku, barcode, reorder_threshold'),
    client.from('products').select('id, name, image_url, category_id'),
    client.from('locations').select('id, name'),
    client.from('categories').select('id, name').order('name'),
  ]);

  const firstError = balErr || variantErr || prodErr || locErr;
  if (firstError) {
    document.getElementById('inventory-error').textContent = firstError.message;
    document.getElementById('inventory-body').innerHTML = '';
    return;
  }

  locations = locs;
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const categoryName = Object.fromEntries((categories ?? []).map((c) => [c.id, c.name]));

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
      const product = productById[v.product_id];
      const total = Object.values(r.qty).reduce((sum, q) => sum + q, 0);
      return {
        variant: v,
        product,
        categoryId: product?.category_id ?? '',
        categoryName: categoryName[product?.category_id] ?? '',
        qty: r.qty,
        total,
        status: stockStatus(total, v.reorder_threshold),
        // Quantity-weighted across locations; falls back to any location's average when
        // nothing is in stock yet.
        avgCost: r.costUnits > 0 ? Math.round(r.costTotal / r.costUnits) : r.anyCost,
        currency: r.currency,
        needsReview: r.needsReview,
      };
    })
    .sort((a, b) => (a.product?.name ?? '').localeCompare(b.product?.name ?? '') || a.variant.sku.localeCompare(b.variant.sku));

  document.getElementById('filter-category').innerHTML += (categories ?? [])
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join('');

  document.getElementById('inventory-stats').innerHTML = [
    statCard({ label: 'Total variants', value: rows.length, iconName: 'box', tone: 'blue' }),
    statCard({ label: 'In stock', value: rows.filter((r) => r.status === 'in').length, iconName: 'box', tone: 'green' }),
    statCard({ label: 'Low stock', value: rows.filter((r) => r.status === 'low').length, iconName: 'alert', tone: 'amber' }),
    statCard({ label: 'Out of stock', value: rows.filter((r) => r.status === 'out').length, iconName: 'box', tone: 'red' }),
  ].join('');

  document.getElementById('inventory-head').innerHTML = `
    <tr>
      <th>SKU</th><th>Product</th><th>Variant</th>
      ${locations.map((l) => `<th class="num">${l.name}</th>`).join('')}
      ${locations.length > 1 ? '<th class="num">Total</th>' : ''}
      <th class="num">Avg. unit cost</th><th>Status</th><th></th>
    </tr>`;

  const search = document.getElementById('inventory-search');
  search.addEventListener('input', () => {
    view.term = search.value.trim().toLowerCase();
    view.page = 1;
    renderRows();
  });
  document.getElementById('filter-category').addEventListener('change', (e) => {
    view.category = e.target.value;
    view.page = 1;
    renderRows();
  });
  document.getElementById('filter-status').addEventListener('change', (e) => {
    view.status = e.target.value;
    view.page = 1;
    renderRows();
  });
  document.getElementById('export-btn').addEventListener('click', exportCsv);

  // Deep link from elsewhere (e.g. a low-stock count) -- inventory.html?status=low
  const status = new URLSearchParams(location.search).get('status');
  if (['in', 'low', 'out'].includes(status)) {
    view.status = status;
    document.getElementById('filter-status').value = status;
  }

  renderRows();
}

function filteredRows() {
  return rows.filter((r) => {
    if (view.category && r.categoryId !== view.category) return false;
    if (view.status && r.status !== view.status) return false;
    if (!view.term) return true;
    return (
      (r.product?.name ?? '').toLowerCase().includes(view.term) ||
      r.variant.sku.toLowerCase().includes(view.term) ||
      (r.variant.barcode ?? '') === view.term
    );
  });
}

function renderRows() {
  const visible = filteredRows();
  const { from, to, page } = renderPagination(document.getElementById('inventory-pagination'), {
    total: visible.length,
    page: view.page,
    noun: 'variants',
    onPage: (n) => {
      view.page = n;
      renderRows();
    },
  });
  view.page = page;

  const colspan = 7 + locations.length + (locations.length > 1 ? 1 : 0);
  document.getElementById('inventory-body').innerHTML =
    visible
      .slice(from, to)
      .map((r) => {
        const variantLabel = [r.variant.size, r.variant.color].filter(Boolean).join(' / ') || '—';
        return `
        <tr class="product-row${r.needsReview ? ' needs-review' : ''}" data-id="${r.variant.id}">
          <td class="muted nowrap">${r.variant.sku ?? '—'}</td>
          <td><a class="cell-product" href="variant.html?id=${r.variant.id}">${thumb(r.product?.image_url, '', 'sm')}<span class="name">${r.product?.name ?? 'Unknown product'}</span></a></td>
          <td class="muted">${variantLabel}</td>
          ${locations.map((l) => `<td class="num">${r.qty[l.id] ?? 0}</td>`).join('')}
          ${locations.length > 1 ? `<td class="num"><strong>${r.total}</strong></td>` : ''}
          <td class="num">${formatCents(r.avgCost, r.currency)}</td>
          <td>${r.needsReview ? '<span class="pill pill-warning">Needs review</span>' : stockPill(r.status)}</td>
          <td>${r.status !== 'in' ? `<a href="purchase-orders.html?variant=${r.variant.id}">Reorder</a>` : ''}</td>
        </tr>`;
      })
      .join('') || `<tr><td colspan="${colspan}" class="muted" style="text-align: center; padding: 32px;">No variants match these filters.</td></tr>`;

  document.querySelectorAll('#inventory-body .product-row').forEach((row) =>
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      location.href = `variant.html?id=${row.dataset.id}`;
    })
  );
}

function exportCsv() {
  const header = ['SKU', 'Product', 'Variant', 'Category', ...locations.map((l) => l.name), ...(locations.length > 1 ? ['Total'] : []), 'Status'];
  const lines = filteredRows().map((r) => [
    r.variant.sku,
    r.product?.name ?? '',
    [r.variant.size, r.variant.color].filter(Boolean).join(' / '),
    r.categoryName,
    ...locations.map((l) => r.qty[l.id] ?? 0),
    ...(locations.length > 1 ? [r.total] : []),
    { in: 'In stock', low: 'Low stock', out: 'Out of stock' }[r.status],
  ]);
  const csv = [header, ...lines].map((cols) => cols.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

init();
