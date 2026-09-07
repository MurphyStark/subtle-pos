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
    client.from('product_variants').select('id, product_id, size, color, sku'),
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

  const rows = balances.slice().sort((a, b) => {
    const nameA = productById[variantById[a.variant_id]?.product_id]?.name ?? '';
    const nameB = productById[variantById[b.variant_id]?.product_id]?.name ?? '';
    return nameA.localeCompare(nameB);
  });

  document.getElementById('inventory-body').innerHTML =
    rows
      .map((b) => {
        const variant = variantById[b.variant_id];
        const product = productById[variant?.product_id];
        const location = locationById[b.location_id];
        const variantLabel = [variant?.size, variant?.color].filter(Boolean).join(' / ') || '—';
        return `
        <tr class="${b.needs_review ? 'needs-review' : ''}">
          <td>${variant?.sku ?? '—'}</td>
          <td>${product?.name ?? 'Unknown product'}</td>
          <td>${variantLabel}</td>
          <td>${location?.name ?? '—'}</td>
          <td>${b.quantity_available}</td>
          <td>${formatCents(b.average_unit_cost_cents, b.currency)}</td>
          <td>${b.needs_review ? '⚠ needs review' : ''}</td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="7">No inventory recorded yet.</td></tr>';
}

init();
