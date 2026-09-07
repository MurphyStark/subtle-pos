import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { resizeImage } from './image.js';

// Manager/owner only -- RLS enforces this independently (products/product_prices writes
// require is_manager_or_owner(), and product_cost_history is manager/owner-only to even
// read), this requireAuth call just gives a cashier who wanders here a clean message.
let profile = null;
let locations = [];

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  const client = getClient();
  const { data: locs } = await client.from('locations').select('id, name');
  locations = locs ?? [];

  const locationSelect = document.querySelector('select[name="location_id"]');
  locationSelect.innerHTML = locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  if (profile.primary_location_id) locationSelect.value = profile.primary_location_id;

  document.querySelector('input[name="photo"]').addEventListener('change', previewPhoto);
  document.getElementById('product-form').addEventListener('submit', handleCreateProduct);

  await renderProductList();
}

function previewPhoto(event) {
  const file = event.target.files?.[0];
  const preview = document.getElementById('photo-preview');
  if (!file) {
    preview.innerHTML = '';
    return;
  }
  const url = URL.createObjectURL(file);
  preview.innerHTML = `<img src="${url}" alt="Preview" />`;
}

// Every product needs a cost basis before it can ever be sold (the sales trigger looks up
// product_cost_history and refuses to sell a product with none) -- so "add a product" always
// creates an initial stock_receipt, even for a quantity of 0. Reused by both real Supabase
// and the demo mock, which mirrors the same weighted-average-cost logic (see mockClient.js).
async function getOrCreateManualSupplier(client) {
  const { data: existing } = await client.from('suppliers').select('id, name').eq('name', 'Manual Entry');
  if (existing?.[0]) return existing[0].id;
  const id = crypto.randomUUID();
  await client.from('suppliers').insert({ id, name: 'Manual Entry' });
  return id;
}

async function uploadProductPhoto(client, file, productId) {
  const blob = await resizeImage(file);
  const path = `${productId}.jpg`;
  const { error: uploadError } = await client.storage
    .from('product-images')
    .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
  if (uploadError) throw uploadError;
  const { data } = client.storage.from('product-images').getPublicUrl(path);
  return data.publicUrl;
}

async function handleCreateProduct(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('product-error');
  const successEl = document.getElementById('product-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const client = getClient();
    const currency = form.currency.value;
    const productId = crypto.randomUUID();

    await client.from('products').insert({
      id: productId,
      sku: form.sku.value.trim(),
      barcode: form.barcode.value.trim() || null,
      name: form.name.value.trim(),
      base_currency: currency,
      min_wholesale_qty: Number(form.min_wholesale_qty.value) || 1,
      is_active: true,
    });

    const priceRows = [
      { product_id: productId, price_type: 'retail', unit_price_cents: toCents(form.retail_price.value), currency },
    ];
    if (form.wholesale_price.value) {
      priceRows.push({ product_id: productId, price_type: 'wholesale', unit_price_cents: toCents(form.wholesale_price.value), currency });
    }
    await client.from('product_prices').insert(priceRows);

    // A product needs a cost basis (a product_cost_history row) before it can ever be
    // sold -- the sales trigger looks one up and refuses the sale otherwise. If there's
    // physical stock on hand, record it properly as a stock receipt (quantity > 0 is
    // required there, and it's what actually drives the weighted-average cost). If not,
    // insert the cost basis directly rather than faking a receipt for units that were
    // never received.
    const supplierId = await getOrCreateManualSupplier(client);
    const quantity = Number(form.initial_qty.value) || 0;
    const costCents = toCents(form.cost_price.value);

    if (quantity > 0) {
      const receiptId = crypto.randomUUID();
      await client.from('stock_receipts').insert({
        id: receiptId,
        supplier_id: supplierId,
        location_id: form.location_id.value,
        purchase_cost_cents: costCents * quantity,
        currency,
        sync_status: 'synced',
      });
      await client.from('stock_receipt_items').insert({
        id: crypto.randomUUID(),
        stock_receipt_id: receiptId,
        product_id: productId,
        quantity,
        unit_landed_cost_cents: costCents,
      });
    } else {
      await client.from('product_cost_history').insert({
        product_id: productId,
        supplier_id: supplierId,
        unit_cost_cents: costCents,
        currency,
      });
    }

    const photoFile = form.photo.files?.[0];
    if (photoFile) {
      const imageUrl = await uploadProductPhoto(client, photoFile, productId);
      await client.from('products').update({ image_url: imageUrl }).eq('id', productId);
    }

    successEl.textContent = `${form.name.value.trim()} added.`;
    form.reset();
    document.getElementById('photo-preview').innerHTML = '';
    await renderProductList();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  } finally {
    submitBtn.disabled = false;
  }
}

async function updatePrice(productId, priceType, currency, valueInput) {
  const client = getClient();
  const cents = toCents(valueInput);
  if (!Number.isFinite(cents) || cents < 0) return;
  await client.from('product_prices').insert({ product_id: productId, price_type: priceType, unit_price_cents: cents, currency });
  await renderProductList();
}

async function renderProductList() {
  const client = getClient();
  const [{ data: products }, { data: prices }, { data: balances }] = await Promise.all([
    client.from('products').select('*'),
    client.from('product_prices').select('*').order('effective_date', { ascending: false }),
    client.from('v_inventory_balances').select('*'),
  ]);

  const latestPrice = {};
  for (const p of prices ?? []) {
    const key = `${p.product_id}:${p.price_type}`;
    if (!latestPrice[key]) latestPrice[key] = p;
  }

  const stockByProduct = {};
  for (const b of balances ?? []) {
    stockByProduct[b.product_id] = (stockByProduct[b.product_id] ?? 0) + b.quantity_available;
  }

  const tbody = document.getElementById('product-list-body');
  tbody.innerHTML =
    (products ?? [])
      .map((p) => {
        const retail = latestPrice[`${p.id}:retail`];
        const wholesale = latestPrice[`${p.id}:wholesale`];
        const currency = retail?.currency ?? p.base_currency;
        return `
        <tr>
          <td>${p.image_url ? `<img class="product-thumb" src="${p.image_url}" alt="${p.name}" />` : ''}</td>
          <td>${p.sku}</td>
          <td>${p.name}</td>
          <td>${retail ? formatCents(retail.unit_price_cents, currency) : '—'}</td>
          <td>${wholesale ? formatCents(wholesale.unit_price_cents, currency) : '—'}</td>
          <td>${stockByProduct[p.id] ?? 0}</td>
          <td><button type="button" class="ghost edit-price-btn" data-id="${p.id}" data-currency="${currency}"
                data-retail="${retail ? (retail.unit_price_cents / 100).toFixed(2) : ''}"
                data-wholesale="${wholesale ? (wholesale.unit_price_cents / 100).toFixed(2) : ''}">Update price</button></td>
        </tr>
        <tr class="price-edit-target" data-for="${p.id}" hidden>
          <td colspan="7">
            <div class="price-edit-row">
              Retail <input type="number" min="0" step="0.01" class="edit-retail" value="${retail ? (retail.unit_price_cents / 100).toFixed(2) : ''}" />
              Wholesale <input type="number" min="0" step="0.01" class="edit-wholesale" value="${wholesale ? (wholesale.unit_price_cents / 100).toFixed(2) : ''}" />
              <button type="button" class="primary save-price-btn" data-id="${p.id}" data-currency="${currency}">Save</button>
            </div>
          </td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="7">No products yet.</td></tr>';

  tbody.querySelectorAll('.edit-price-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = tbody.querySelector(`.price-edit-target[data-for="${btn.dataset.id}"]`);
      row.hidden = !row.hidden;
    });
  });
  tbody.querySelectorAll('.save-price-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const retailVal = row.querySelector('.edit-retail').value;
      const wholesaleVal = row.querySelector('.edit-wholesale').value;
      if (retailVal) await updatePrice(btn.dataset.id, 'retail', btn.dataset.currency, retailVal);
      if (wholesaleVal) await updatePrice(btn.dataset.id, 'wholesale', btn.dataset.currency, wholesaleVal);
    });
  });
}

init();
