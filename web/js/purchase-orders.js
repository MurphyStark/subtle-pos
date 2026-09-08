import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// STEP 5 of the fashion-retail evolution. Manager/owner only (RLS: purchase_orders_all /
// purchase_order_items_all require is_manager_or_owner()).
//
// "Mark received" deliberately does NOT duplicate stock/cost logic -- it creates a real
// stock_receipts/stock_receipt_items row (the exact mechanism admin.js already uses for a
// new variant's initial stock), which already recomputes weighted-average cost and drops a
// product_cost_history row via fn_apply_stock_receipt_item. purchase_order_id on the
// receipt is traceability only; quantity_received/status on the PO itself are updated by
// this page afterward, not by a database trigger -- that's workflow status, not financial
// history.
let profile = null;
let locations = [];
let variantOptions = []; // [{ id, label, sku }]
let draftLines = []; // [{ variant_id, label, quantity, expected_unit_cost_cents }]
let expandedPoId = null;

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner']);
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
      return { id: v.id, sku: v.sku, label: `${productName}${label ? ` — ${label}` : ''} (${v.sku})` };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const locationSelect = document.querySelector('select[name="location_id"]');
  locationSelect.innerHTML = locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  if (profile.primary_location_id) locationSelect.value = profile.primary_location_id;

  const variantSelect = document.getElementById('po-line-variant');
  variantSelect.innerHTML = variantOptions.map((v) => `<option value="${v.id}">${v.label}</option>`).join('');

  document.getElementById('po-line-add').addEventListener('click', addDraftLine);
  document.getElementById('po-form').addEventListener('submit', handleCreatePo);

  await renderPoList();
}

function addDraftLine() {
  const variantSelect = document.getElementById('po-line-variant');
  const qtyInput = document.getElementById('po-line-qty');
  const costInput = document.getElementById('po-line-cost');

  const variant = variantOptions.find((v) => v.id === variantSelect.value);
  const quantity = Number(qtyInput.value) || 0;
  const costCents = toCents(costInput.value || 0);
  if (!variant || quantity <= 0) return;

  draftLines.push({ variant_id: variant.id, label: variant.label, quantity, expected_unit_cost_cents: costCents });
  qtyInput.value = 1;
  costInput.value = '';
  renderDraftLines();
}

function renderDraftLines() {
  const tbody = document.getElementById('po-lines-body');
  tbody.innerHTML = draftLines
    .map(
      (line, i) => `
    <tr>
      <td>${line.label}</td>
      <td>${line.quantity}</td>
      <td>${formatCents(line.expected_unit_cost_cents, 'USD')}</td>
      <td><button type="button" class="ghost remove-line-btn" data-index="${i}">Remove</button></td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('.remove-line-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      draftLines.splice(Number(btn.dataset.index), 1);
      renderDraftLines();
    });
  });

  document.getElementById('po-submit-btn').disabled = draftLines.length === 0;
}

// Reused pattern from admin.js's getOrCreateManualSupplier, generalized to a real supplier
// name -- a PO needs the actual supplier, not the "Manual Entry" placeholder.
async function getOrCreateSupplierByName(client, name) {
  const trimmed = name.trim();
  const { data: existing } = await client.from('suppliers').select('id, name').eq('name', trimmed);
  if (existing?.[0]) return existing[0].id;
  const id = crypto.randomUUID();
  await client.from('suppliers').insert({ id, name: trimmed });
  return id;
}

async function handleCreatePo(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('po-error');
  const successEl = document.getElementById('po-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  try {
    const client = getClient();
    const supplierId = await getOrCreateSupplierByName(client, form.supplier_name.value);
    const poId = crypto.randomUUID();

    await client.from('purchase_orders').insert({
      id: poId,
      supplier_id: supplierId,
      location_id: form.location_id.value,
      status: 'sent',
      currency: form.currency.value,
      created_by: profile.id,
      // Explicit rather than relying on the column's DB-level DEFAULT now() -- the demo
      // mock has no concept of column defaults, and this list sorts/displays by it.
      created_at: new Date().toISOString(),
    });
    await client.from('purchase_order_items').insert(
      draftLines.map((line) => ({
        id: crypto.randomUUID(),
        purchase_order_id: poId,
        variant_id: line.variant_id,
        quantity_ordered: line.quantity,
        expected_unit_cost_cents: line.expected_unit_cost_cents,
        // Explicit rather than relying on the column's DB-level DEFAULT 0 -- the demo mock
        // has no concept of column defaults, so an omitted value would come back as
        // undefined there (and `undefined - x` is NaN, silently breaking the "remaining to
        // receive" calculation in the receiving UI below).
        quantity_received: 0,
      }))
    );

    successEl.textContent = 'Purchase order created.';
    draftLines = [];
    renderDraftLines();
    form.reset();
    expandedPoId = poId;
    await renderPoList();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  }
}

async function handleReceive(po, lines) {
  const client = getClient();
  const container = document.getElementById(`po-receive-${po.id}`);
  const toReceive = lines
    .map((line) => {
      const input = container.querySelector(`.receive-qty-input[data-line-id="${line.id}"]`);
      const qty = Number(input?.value ?? 0);
      return { line, qty };
    })
    .filter((r) => r.qty > 0);

  if (toReceive.length === 0) return;

  const receiptId = crypto.randomUUID();
  const purchaseCostCents = toReceive.reduce((sum, r) => sum + r.qty * r.line.expected_unit_cost_cents, 0);

  await client.from('stock_receipts').insert({
    id: receiptId,
    supplier_id: po.supplier_id,
    location_id: po.location_id,
    purchase_order_id: po.id,
    purchase_cost_cents: purchaseCostCents,
    currency: po.currency,
    sync_status: 'synced',
  });
  await client.from('stock_receipt_items').insert(
    toReceive.map((r) => ({
      id: crypto.randomUUID(),
      stock_receipt_id: receiptId,
      variant_id: r.line.variant_id,
      quantity: r.qty,
      unit_landed_cost_cents: r.line.expected_unit_cost_cents,
    }))
  );

  for (const r of toReceive) {
    await client
      .from('purchase_order_items')
      .update({ quantity_received: r.line.quantity_received + r.qty })
      .eq('id', r.line.id);
  }

  const { data: refreshedLines } = await client.from('purchase_order_items').select('*').eq('purchase_order_id', po.id);
  const allReceived = refreshedLines.every((l) => l.quantity_received >= l.quantity_ordered);
  const anyReceived = refreshedLines.some((l) => l.quantity_received > 0);
  await client
    .from('purchase_orders')
    .update({ status: allReceived ? 'received' : anyReceived ? 'partially_received' : po.status })
    .eq('id', po.id);

  await renderPoList();
}

async function renderPoList() {
  const client = getClient();
  const [{ data: pos }, { data: items }, { data: suppliers }] = await Promise.all([
    client.from('purchase_orders').select('*').order('created_at', { ascending: false }),
    client.from('purchase_order_items').select('*'),
    client.from('suppliers').select('id, name'),
  ]);

  const locationName = Object.fromEntries(locations.map((l) => [l.id, l.name]));
  const supplierName = Object.fromEntries((suppliers ?? []).map((s) => [s.id, s.name]));
  const variantById = Object.fromEntries(variantOptions.map((v) => [v.id, v]));
  const itemsByPo = {};
  for (const item of items ?? []) {
    (itemsByPo[item.purchase_order_id] ??= []).push(item);
  }

  const container = document.getElementById('po-list');
  container.innerHTML =
    (pos ?? [])
      .map((po) => {
        const lines = itemsByPo[po.id] ?? [];
        const expanded = expandedPoId === po.id;
        const lineRows = lines
          .map((line) => {
            const remaining = line.quantity_ordered - line.quantity_received;
            return `
            <tr>
              <td>${variantById[line.variant_id]?.label ?? line.variant_id}</td>
              <td>${line.quantity_ordered}</td>
              <td>${line.quantity_received}</td>
              <td>${remaining}</td>
              <td>${remaining > 0 ? `<input type="number" class="receive-qty-input" data-line-id="${line.id}" min="0" max="${remaining}" value="${remaining}" style="width: 70px;" />` : '—'}</td>
            </tr>`;
          })
          .join('');

        return `
        <div class="card product-card">
          <div class="product-card-header" data-id="${po.id}">
            <span class="name">${supplierName[po.supplier_id] ?? 'Unknown supplier'}</span>
            <span class="meta">${locationName[po.location_id] ?? ''}</span>
            <span class="meta">${po.status.replace('_', ' ')}</span>
            <span class="meta">${new Date(po.created_at).toLocaleDateString()}</span>
          </div>
          <div class="product-card-body" ${expanded ? '' : 'hidden'}>
            <table class="variant-table">
              <thead><tr><th>Variant</th><th>Ordered</th><th>Received</th><th>Remaining</th><th>Receive now</th></tr></thead>
              <tbody id="po-receive-${po.id}">${lineRows}</tbody>
            </table>
            ${
              po.status !== 'received' && po.status !== 'cancelled'
                ? `<button type="button" class="primary receive-btn" data-id="${po.id}">Record receipt</button>`
                : ''
            }
          </div>
        </div>`;
      })
      .join('') || '<p style="color: var(--text-muted);">No purchase orders yet.</p>';

  container.querySelectorAll('.product-card-header').forEach((header) => {
    header.addEventListener('click', () => {
      expandedPoId = expandedPoId === header.dataset.id ? null : header.dataset.id;
      renderPoList();
    });
  });
  container.querySelectorAll('.receive-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const po = (pos ?? []).find((p) => p.id === btn.dataset.id);
      handleReceive(po, itemsByPo[po.id] ?? []);
    });
  });
}

init();
