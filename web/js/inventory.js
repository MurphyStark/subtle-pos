import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// Manager/owner only -- RLS enforces this independently (v_inventory_balances masks
// average_unit_cost_cents for anyone else), this requireAuth call is just so a cashier who
// wanders here gets a clean "restricted" message instead of an empty/broken table.
async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner']);
  if (!auth) return;
  renderNav(auth.profile);

  const client = getClient();
  const [{ data: balances, error: balErr }, { data: products, error: prodErr }, { data: locations, error: locErr }] =
    await Promise.all([
      client.from('v_inventory_balances').select('*'),
      client.from('products').select('id, sku, name'),
      client.from('locations').select('id, name'),
    ]);

  const firstError = balErr || prodErr || locErr;
  if (firstError) {
    document.getElementById('inventory-error').textContent = firstError.message;
    document.getElementById('inventory-body').innerHTML = '';
    return;
  }

  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const locationById = Object.fromEntries(locations.map((l) => [l.id, l]));

  const rows = balances
    .slice()
    .sort((a, b) => (productById[a.product_id]?.name ?? '').localeCompare(productById[b.product_id]?.name ?? ''));

  document.getElementById('inventory-body').innerHTML =
    rows
      .map((b) => {
        const product = productById[b.product_id];
        const location = locationById[b.location_id];
        return `
        <tr class="${b.needs_review ? 'needs-review' : ''}">
          <td>${product?.sku ?? '—'}</td>
          <td>${product?.name ?? 'Unknown product'}</td>
          <td>${location?.name ?? '—'}</td>
          <td>${b.quantity_available}</td>
          <td>${formatCents(b.average_unit_cost_cents, b.currency)}</td>
          <td>${b.needs_review ? '⚠ needs review' : ''}</td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="6">No inventory recorded yet.</td></tr>';
}

init();
