import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// STEP 5 of the fashion-retail evolution. Any role can REQUEST a transfer from their own
// location (RLS: inventory_transfers_insert lets a cashier insert with
// from_location_id = their own primary_location_id); only managers/owner can approve/
// progress it (RLS: inventory_transfers_update / inventory_transfer_items_update both
// require is_manager_or_owner()). This page reflects that split -- everyone can see it and
// request one, but the "Approve & mark received" action only renders for managers/owner
// (and would be rejected by RLS anyway if a cashier tried to call it directly).
let profile = null;
let locations = [];
let variantOptions = [];

async function init() {
  registerServiceWorker();

  const auth = await requireAuth();
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

  const isManager = profile.role !== 'cashier';
  const fromSelect = document.querySelector('select[name="from_location_id"]');
  const toSelect = document.querySelector('select[name="to_location_id"]');
  fromSelect.innerHTML = locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  toSelect.innerHTML = locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  if (profile.primary_location_id) fromSelect.value = profile.primary_location_id;
  fromSelect.disabled = !isManager; // a cashier can only ever request FROM their own location

  document.getElementById('transfer-form').querySelector('select[name="variant_id"]').innerHTML =
    variantOptions.map((v) => `<option value="${v.id}">${v.label}</option>`).join('');

  document.getElementById('transfer-form').addEventListener('submit', handleRequestTransfer);

  await renderTransferList();
}

async function handleRequestTransfer(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('transfer-error');
  const successEl = document.getElementById('transfer-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const fromLocationId = form.from_location_id.value;
  const toLocationId = form.to_location_id.value;
  if (fromLocationId === toLocationId) {
    errorEl.textContent = 'From and To must be different locations.';
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
      .eq('variant_id', form.variant_id.value)
      .eq('location_id', fromLocationId);
    const sourceCost = balances?.[0]?.average_unit_cost_cents ?? 0;

    const transferId = crypto.randomUUID();
    await client.from('inventory_transfers').insert({
      id: transferId,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      status: 'requested',
      requested_by: profile.id,
      sync_status: 'synced',
      // Explicit rather than relying on the column's DB-level DEFAULT now() -- the demo
      // mock has no concept of column defaults, and this list sorts/displays by it.
      created_at: new Date().toISOString(),
    });
    await client.from('inventory_transfer_items').insert({
      id: crypto.randomUUID(),
      inventory_transfer_id: transferId,
      variant_id: form.variant_id.value,
      quantity_requested: Number(form.quantity.value),
      unit_cost_at_transfer_cents: sourceCost,
    });

    successEl.textContent = 'Transfer requested.';
    form.reset();
    if (profile.primary_location_id) form.from_location_id.value = profile.primary_location_id;
    await renderTransferList();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  }
}

async function handleApproveAndReceive(transfer, item) {
  const client = getClient();
  await client
    .from('inventory_transfer_items')
    .update({ quantity_sent: item.quantity_requested, quantity_received: item.quantity_requested })
    .eq('id', item.id);
  await client
    .from('inventory_transfers')
    .update({ status: 'received', approved_by: profile.id })
    .eq('id', transfer.id);
  await renderTransferList();
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

  const isManager = profile.role !== 'cashier';
  const tbody = document.getElementById('transfer-list-body');
  tbody.innerHTML =
    (transfers ?? [])
      .flatMap((t) =>
        (itemsByTransfer[t.id] ?? []).map(
          (item) => `
        <tr>
          <td>${new Date(t.created_at).toLocaleDateString()}</td>
          <td>${locationName[t.from_location_id] ?? ''}</td>
          <td>${locationName[t.to_location_id] ?? ''}</td>
          <td>${variantLabel[item.variant_id] ?? item.variant_id}</td>
          <td>${item.quantity_requested}</td>
          <td>${t.status.replace('_', ' ')}</td>
          <td>${
            isManager && t.status !== 'received' && t.status !== 'cancelled'
              ? `<button type="button" class="ghost approve-btn" data-transfer-id="${t.id}" data-item-id="${item.id}">Approve &amp; mark received</button>`
              : ''
          }</td>
        </tr>`
        )
      )
      .join('') || '<tr><td colspan="7">No transfers yet.</td></tr>';

  tbody.querySelectorAll('.approve-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const transfer = (transfers ?? []).find((t) => t.id === btn.dataset.transferId);
      const item = (items ?? []).find((i) => i.id === btn.dataset.itemId);
      handleApproveAndReceive(transfer, item);
    });
  });
}

init();
