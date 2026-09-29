import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// Admin-only: moves stock between the shop and the Warehouse. The Warehouse is invisible to
// every other role (warehouse_location migration: locations_select + restrictive
// can_access_location() policies), so a transfer touching it could never be created or read
// by anyone else anyway -- requireAuth here just gives them a clean "restricted" page.
//
// A move is recorded as a normal inventory_transfers row that goes straight to 'received':
// the admin is both requester and approver, so the old request -> approve split adds a
// click without adding a control. fn_apply_transfer_receipt (mirrored in the demo mock) does
// the actual stock movement and weighted-average-cost blending on that status change.
let profile = null;
let locations = [];
let variantOptions = [];
let qtyByVariantLocation = {};

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['admin']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  const client = getClient();
  const [{ data: locs }, { data: products }, { data: variants }] = await Promise.all([
    client.from('locations').select('id, name'),
    client.from('products').select('id, name'),
    client.from('product_variants').select('id, product_id, size, color, sku').eq('is_active', true),
  ]);
  locations = locs ?? [];

  const productById = Object.fromEntries((products ?? []).map((p) => [p.id, p]));
  variantOptions = (variants ?? [])
    .map((v) => {
      const label = [v.size, v.color].filter(Boolean).join(' / ');
      const productName = productById[v.product_id]?.name ?? 'Unknown product';
      return { id: v.id, label: `${productName}${label ? ` — ${label}` : ''} (${v.sku})` };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const fromSelect = document.querySelector('select[name="from_location_id"]');
  const toSelect = document.querySelector('select[name="to_location_id"]');
  fromSelect.innerHTML = locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  toSelect.innerHTML = locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  // Default direction is the common one: restocking the shop from the Warehouse.
  const warehouse = locations.find((l) => l.id !== profile.primary_location_id);
  if (warehouse) fromSelect.value = warehouse.id;
  if (profile.primary_location_id) toSelect.value = profile.primary_location_id;

  document.getElementById('transfer-form').querySelector('select[name="variant_id"]').innerHTML =
    variantOptions.map((v) => `<option value="${v.id}">${v.label}</option>`).join('');

  const form = document.getElementById('transfer-form');
  form.addEventListener('submit', handleMoveStock);
  form.addEventListener('change', renderAvailable);

  await loadBalances();
  renderAvailable();
  await renderTransferList();
}

async function loadBalances() {
  const { data: balances } = await getClient().from('v_inventory_balances').select('variant_id, location_id, quantity_available');
  qtyByVariantLocation = {};
  for (const b of balances ?? []) qtyByVariantLocation[`${b.variant_id}|${b.location_id}`] = b.quantity_available;
}

function renderAvailable() {
  const form = document.getElementById('transfer-form');
  const locationName = Object.fromEntries(locations.map((l) => [l.id, l.name]));
  const variantId = form.variant_id.value;
  document.getElementById('transfer-available').textContent = locations
    .map((l) => `${locationName[l.id]}: ${qtyByVariantLocation[`${variantId}|${l.id}`] ?? 0}`)
    .join(' · ');
}

async function handleMoveStock(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('transfer-error');
  const successEl = document.getElementById('transfer-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const fromLocationId = form.from_location_id.value;
  const toLocationId = form.to_location_id.value;
  const variantId = form.variant_id.value;
  const quantity = Number(form.quantity.value);
  if (fromLocationId === toLocationId) {
    errorEl.textContent = 'From and To must be different locations.';
    return;
  }
  const available = qtyByVariantLocation[`${variantId}|${fromLocationId}`] ?? 0;
  if (quantity > available) {
    errorEl.textContent = `Only ${available} in stock at the source location.`;
    return;
  }

  try {
    const client = getClient();

    // Snapshot the source location's current weighted-average cost -- see
    // inventory_transfer_items.unit_cost_at_transfer_cents's comment in the schema: this is
    // what keeps the destination's average cost correct once the transfer lands.
    const { data: balances } = await client
      .from('v_inventory_balances')
      .select('variant_id, location_id, average_unit_cost_cents')
      .eq('variant_id', variantId)
      .eq('location_id', fromLocationId);
    const sourceCost = balances?.[0]?.average_unit_cost_cents ?? 0;

    const transferId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const steps = [
      client.from('inventory_transfers').insert({
        id: transferId,
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        status: 'requested',
        requested_by: profile.id,
        sync_status: 'synced',
        // Explicit rather than relying on the column's DB-level DEFAULT now() -- the demo
        // mock has no concept of column defaults, and this list sorts/displays by it.
        created_at: new Date().toISOString(),
      }),
      client.from('inventory_transfer_items').insert({
        id: itemId,
        inventory_transfer_id: transferId,
        variant_id: variantId,
        quantity_requested: quantity,
        quantity_sent: quantity,
        quantity_received: quantity,
        unit_cost_at_transfer_cents: sourceCost,
      }),
      client.from('inventory_transfers').update({ status: 'received', approved_by: profile.id }).eq('id', transferId),
    ];
    for (const step of steps) {
      const { error } = await step;
      if (error) throw new Error(error.message);
    }

    successEl.textContent = `Moved ${quantity}.`;
    form.quantity.value = 1;
    await loadBalances();
    renderAvailable();
    await renderTransferList();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  }
}

async function renderTransferList() {
  const client = getClient();
  const [{ data: transfers }, { data: items }] = await Promise.all([
    client.from('inventory_transfers').select('*').order('created_at', { ascending: false }),
    client.from('inventory_transfer_items').select('*'),
  ]);

  const locationName = Object.fromEntries(locations.map((l) => [l.id, l.name]));
  const variantLabel = Object.fromEntries(variantOptions.map((v) => [v.id, v.label]));
  const itemsByTransfer = {};
  for (const item of items ?? []) {
    (itemsByTransfer[item.inventory_transfer_id] ??= []).push(item);
  }

  document.getElementById('transfer-list-body').innerHTML =
    (transfers ?? [])
      .flatMap((t) =>
        (itemsByTransfer[t.id] ?? []).map(
          (item) => `
        <tr>
          <td>${new Date(t.created_at).toLocaleDateString()}</td>
          <td>${locationName[t.from_location_id] ?? ''}</td>
          <td>${locationName[t.to_location_id] ?? ''}</td>
          <td>${variantLabel[item.variant_id] ?? item.variant_id}</td>
          <td>${item.quantity_received ?? item.quantity_requested}</td>
          <td>${t.status.replace('_', ' ')}</td>
        </tr>`
        )
      )
      .join('') || '<tr><td colspan="6">No transfers yet.</td></tr>';
}

init();
