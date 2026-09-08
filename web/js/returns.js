import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// STEP 6 of the fashion-retail evolution. Any authenticated role may process a return
// (RLS: sale_item_returns_insert has no role restriction); sales visibility is already
// scoped by sales_select (own location, or any location for managers/owner) -- a return
// can only ever be raised against a sale this account can already see.
let profile = null;
let selectedSale = null;

async function init() {
  registerServiceWorker();

  const auth = await requireAuth();
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  document.getElementById('search-btn').addEventListener('click', runSearch);
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

  try {
    const client = getClient();
    const quantity = Number(form.quantity.value);
    const unitPrice = rowData.item.unit_selling_price_cents;

    const { error } = await client.from('sale_item_returns').insert({
      id: crypto.randomUUID(),
      sale_item_id: rowData.item.id,
      quantity_returned: quantity,
      reason: form.reason.value,
      refund_method: form.refund_method.value,
      refund_amount_cents: quantity * unitPrice,
      processed_by: profile.id,
      sync_status: 'synced',
      created_at: new Date().toISOString(), // explicit, not relying on the column's DB DEFAULT now() -- see purchase-orders.js's note
    });
    if (error) throw error;

    await renderReturnDetail();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
    submitBtn.disabled = false;
  }
}

init();
