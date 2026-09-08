import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { queueOutbox, countPendingOutbox } from './db.js';
import { initSyncListeners, replayOutbox } from './sync.js';
import { logActivity } from './activity.js';

// STEP 6 of the fashion-retail evolution. Any authenticated role may process a return
// (RLS: sale_item_returns_insert has no role restriction); sales visibility is already
// scoped by sales_select (own location, or any location for managers/owner) -- a return
// can only ever be raised against a sale this account can already see.
//
// Offline-capable, same pattern as checkout and stock-take: a return that fails to reach
// Supabase (or is attempted while already offline) queues in IndexedDB and replays once
// back online -- a customer standing at the counter with a return shouldn't be turned away
// for a dead connection any more than a sale should. Search itself still needs a live
// connection (it reads from the server), but the actual PROCESS-return write does not.
let profile = null;
let selectedSale = null;

async function init() {
  registerServiceWorker();

  const auth = await requireAuth();
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  document.getElementById('search-btn').addEventListener('click', runSearch);

  initSyncListeners(refreshStatusBanner);
  window.addEventListener('online', refreshStatusBanner);
  window.addEventListener('offline', refreshStatusBanner);
  await refreshStatusBanner();
}

async function refreshStatusBanner() {
  const pending = await countPendingOutbox();
  const banner = document.getElementById('status-banner');
  if (!banner) return;
  if (pending === 0) {
    banner.innerHTML = '';
  } else if (!navigator.onLine) {
    banner.innerHTML = `<div class="status-banner offline">Offline — ${pending} return${pending === 1 ? '' : 's'} queued and will sync once you're back online.</div>`;
  } else {
    banner.innerHTML = `<div class="status-banner pending">Syncing ${pending} queued return${pending === 1 ? '' : 's'}…</div>`;
  }
}

async function runSearch() {
  const client = getClient();
  const receiptTerm = document.getElementById('search-receipt').value.trim().toLowerCase();
  const customerTerm = document.getElementById('search-customer').value.trim().toLowerCase();
  const fromDate = document.getElementById('search-from').value;
  const toDate = document.getElementById('search-to').value;

  const [{ data: sales }, { data: customers }, { data: locations }] = await Promise.all([
    client.from('sales').select('*').order('created_at', { ascending: false }),
    client.from('customers').select('*'),
    client.from('locations').select('id, name'),
  ]);

  const customerById = Object.fromEntries((customers ?? []).map((c) => [c.id, c]));
  const locationName = Object.fromEntries((locations ?? []).map((l) => [l.id, l.name]));

  const results = (sales ?? []).filter((s) => {
    if (receiptTerm && !s.id.toLowerCase().startsWith(receiptTerm)) return false;
    if (customerTerm) {
      const customer = customerById[s.customer_id];
      const matches =
        customer && (customer.name.toLowerCase().includes(customerTerm) || customer.phone?.toLowerCase().includes(customerTerm));
      if (!matches) return false;
    }
    if (fromDate && new Date(s.created_at) < new Date(fromDate)) return false;
    if (toDate && new Date(s.created_at) > new Date(`${toDate}T23:59:59`)) return false;
    return true;
  });

  const container = document.getElementById('search-results');
  if (!receiptTerm && !customerTerm && !fromDate && !toDate) {
    container.innerHTML = '<p style="color: var(--text-muted);">Enter at least one search field.</p>';
    return;
  }

  container.innerHTML =
    `<div class="card"><table><thead><tr><th>Receipt #</th><th>Date</th><th>Location</th><th>Customer</th><th>Total</th><th></th></tr></thead><tbody>` +
    (results
      .map(
        (s) => `
      <tr>
        <td>${s.id.slice(0, 8).toUpperCase()}</td>
        <td>${new Date(s.created_at).toLocaleString()}</td>
        <td>${locationName[s.location_id] ?? ''}</td>
        <td>${customerById[s.customer_id]?.name ?? '—'}</td>
        <td>${formatCents(s.total_cents, s.currency)}</td>
        <td><button type="button" class="ghost select-sale-btn" data-id="${s.id}">Select</button></td>
      </tr>`
      )
      .join('') || '<tr><td colspan="6">No matching sales.</td></tr>') +
    `</tbody></table></div>`;

  container.querySelectorAll('.select-sale-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedSale = results.find((s) => s.id === btn.dataset.id);
      renderReturnDetail();
    });
  });
}

// KNOWN LIMITATION: "already returned" quantity comes from the server's
// v_sale_item_returns, so a return that's queued offline (not yet synced) isn't reflected
// here until it lands -- processing two returns against the same line before the first one
// syncs could double up. Accepted for now: the scenario needs the same line item returned
// twice inside one offline window, and the server-side quantity validation (identical
// online or replayed from the queue) still catches it once both entries eventually sync.
async function renderReturnDetail() {
  const client = getClient();
  const detail = document.getElementById('return-detail');
  detail.innerHTML = '<p>Loading…</p>';

  const [{ data: saleItems }, { data: variants }, { data: products }, { data: priorReturns }] = await Promise.all([
    client.from('v_sale_items').select('*').eq('sale_id', selectedSale.id),
    client.from('product_variants').select('id, product_id, size, color, sku'),
    client.from('products').select('id, name'),
    client.from('v_sale_item_returns').select('*'),
  ]);

  const variantById = Object.fromEntries((variants ?? []).map((v) => [v.id, v]));
  const productById = Object.fromEntries((products ?? []).map((p) => [p.id, p]));
  const returnedByLine = {};
  for (const r of priorReturns ?? []) {
    returnedByLine[r.sale_item_id] = (returnedByLine[r.sale_item_id] ?? 0) + r.quantity_returned;
  }

  const rows = (saleItems ?? [])
    .map((item) => {
      const variant = variantById[item.variant_id];
      const product = productById[variant?.product_id];
      const label = [variant?.size, variant?.color].filter(Boolean).join(' / ');
      const alreadyReturned = returnedByLine[item.id] ?? 0;
      const remaining = item.quantity - alreadyReturned;
      return { item, variant, product, label, remaining };
    })
    .filter((r) => r.remaining > 0);

  detail.innerHTML = `
    <div class="card">
      <h2>Receipt ${selectedSale.id.slice(0, 8).toUpperCase()}</h2>
      ${
        rows.length === 0
          ? '<p style="color: var(--text-muted);">Nothing left on this receipt is returnable.</p>'
          : rows
              .map(
                (r) => `
        <form class="return-line-form" data-sale-item-id="${r.item.id}" data-variant-id="${r.item.variant_id}" style="border-bottom: 1px solid var(--border); padding: 0.75rem 0;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>${r.product?.name ?? 'Unknown product'}${r.label ? ` — ${r.label}` : ''} <span style="color: var(--text-muted); font-size: 0.85rem;">(${r.remaining} of ${r.item.quantity} returnable)</span></span>
          </div>
          <div class="add-variant-form" style="grid-template-columns: 1fr 1fr 1fr auto; margin-top: 0.5rem;">
            <label>Qty <input type="number" name="quantity" min="1" max="${r.remaining}" value="1" /></label>
            <label>Reason
              <select name="reason">
                <option value="size">Wrong size</option>
                <option value="defect">Defect</option>
                <option value="changed_mind">Changed mind</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>Refund method
              <select name="refund_method">
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="store_credit">Store credit</option>
                <option value="other">Other</option>
              </select>
            </label>
            <button type="submit" class="primary">Process return</button>
          </div>
          <p class="error return-error"></p>
        </form>`
              )
              .join('')
      }
    </div>
  `;

  detail.querySelectorAll('.return-line-form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const rowData = rows.find((r) => r.item.id === form.dataset.saleItemId);
      handleProcessReturn(form, rowData);
    });
  });
}

async function handleProcessReturn(form, rowData) {
  const errorEl = form.querySelector('.return-error');
  errorEl.textContent = '';
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  const quantity = Number(form.quantity.value);
  const unitPrice = rowData.item.unit_selling_price_cents;
  const returnId = crypto.randomUUID();
  const returnRow = {
    id: returnId,
    sale_item_id: rowData.item.id,
    quantity_returned: quantity,
    reason: form.reason.value,
    refund_method: form.refund_method.value,
    refund_amount_cents: quantity * unitPrice,
    processed_by: profile.id,
    sync_status: 'synced',
    created_at: new Date().toISOString(), // explicit, not relying on the column's DB DEFAULT now() -- see purchase-orders.js's note
  };

  try {
    if (navigator.onLine) {
      const client = getClient();
      const { error } = await client.from('sale_item_returns').insert(returnRow);
      if (error) throw error;
    } else {
      throw new Error('offline'); // fall through to the offline queue below
    }
  } catch (err) {
    // An online-but-failed attempt could mean the quantity was already invalid (someone
    // else returned the same line first) rather than a real connectivity problem -- but
    // there's no way to tell those apart from a plain network error here, and the customer
    // is standing at the counter, so queue it and let the server-side validation (which
    // runs identically once this syncs) be the final word rather than blocking on it now.
    await queueOutbox({
      id: returnId,
      entity_type: 'sale_item_return',
      entity_id: returnId,
      status: 'pending',
      created_at: returnRow.created_at,
      payload: { returnRow },
    });
  }

  await logActivity(
    profile,
    'refund',
    `${profile.full_name} processed a return of ${quantity} unit${quantity === 1 ? '' : 's'} (${form.reason.value}, ${form.refund_method.value})`,
    { return_id: returnId, sale_item_id: rowData.item.id, quantity_returned: quantity }
  );

  await renderReturnDetail();
  await refreshStatusBanner();
  replayOutbox(refreshStatusBanner);
}

init();
