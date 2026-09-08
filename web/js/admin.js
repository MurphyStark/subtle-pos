import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { resizeImage } from './image.js';
import { printLabels } from './labels.js';

// Manager/owner only -- RLS enforces this independently (products/product_variants/
// product_prices writes all require is_manager_or_owner(), and product_cost_history is
// manager/owner-only to even read), this requireAuth call just gives a cashier who
// wanders here a clean message.
//
// STEP 2 of the fashion-retail evolution: a product is now a shell (name/description/
// currency/price/cost); it isn't sellable until it has at least one variant (size/color/
// sku/barcode/stock). Price and cost stay at the product level, shared across variants --
// see the product_variants migration's header comment for why.
let profile = null;
let locations = [];
let expandedProductId = null;

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  const client = getClient();
  const { data: locs } = await client.from('locations').select('id, name');
  locations = locs ?? [];

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
// product_cost_history and refuses to sell a variant of a product with none). Reused by
// both real Supabase and the demo mock, which mirrors the same weighted-average-cost logic
// (see mockClient.js).
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
      name: form.name.value.trim(),
      description: form.description.value.trim() || null,
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

    // Cost basis lives at the product level (shared across variants) -- inserted directly
    // since there's no stock receipt at product-creation time any more (stock now arrives
    // per-variant, added below via "add a variant").
    const supplierId = await getOrCreateManualSupplier(client);
    await client.from('product_cost_history').insert({
      product_id: productId,
      supplier_id: supplierId,
      unit_cost_cents: toCents(form.cost_price.value),
      currency,
    });

    const photoFile = form.photo.files?.[0];
    if (photoFile) {
      const imageUrl = await uploadProductPhoto(client, photoFile, productId);
      await client.from('products').update({ image_url: imageUrl }).eq('id', productId);
    }

    successEl.textContent = `${form.name.value.trim()} added — now add at least one variant below so it can be sold.`;
    form.reset();
    document.getElementById('photo-preview').innerHTML = '';
    expandedProductId = productId;
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

function suggestSku(baseSku, size, color, existingCount) {
  const parts = [baseSku];
  if (size) parts.push(size.toUpperCase().replace(/\s+/g, ''));
  if (color) parts.push(color.slice(0, 3).toUpperCase());
  if (!size && !color) parts.push(String(existingCount + 1).padStart(2, '0'));
  return parts.join('-');
}

async function handleAddVariant(product, form) {
  const errorEl = form.querySelector('.variant-error');
  errorEl.textContent = '';
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const client = getClient();
    const variantId = crypto.randomUUID();
    const size = form.size.value.trim() || null;
    const color = form.color.value.trim() || null;
    const sku = form.sku.value.trim();
    const barcode = form.barcode.value.trim() || null;
    const locationId = form.location_id.value;
    const quantity = Number(form.initial_qty.value) || 0;

    if (!sku) throw new Error('SKU is required.');

    await client.from('product_variants').insert({
      id: variantId,
      product_id: product.id,
      size,
      color,
      sku,
      barcode,
      is_active: true,
    });

    if (quantity > 0) {
      // Landed cost comes from the product's current cost basis -- cost is entered once
      // per product, not re-entered per variant (see the product_variants migration).
      const { data: costRows } = await client
        .from('product_cost_history')
        .select('unit_cost_cents, currency')
        .eq('product_id', product.id)
        .order('effective_date', { ascending: false });
      const latestCost = costRows?.[0];
      if (!latestCost) throw new Error('This product has no recorded cost yet -- cannot receive stock for it.');

      const supplierId = await getOrCreateManualSupplier(client);
      const receiptId = crypto.randomUUID();
      await client.from('stock_receipts').insert({
        id: receiptId,
        supplier_id: supplierId,
        location_id: locationId,
        purchase_cost_cents: latestCost.unit_cost_cents * quantity,
        currency: latestCost.currency,
        sync_status: 'synced',
      });
      await client.from('stock_receipt_items').insert({
        id: crypto.randomUUID(),
        stock_receipt_id: receiptId,
        variant_id: variantId,
        quantity,
        unit_landed_cost_cents: latestCost.unit_cost_cents,
      });
    }

    expandedProductId = product.id;
    await renderProductList();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  } finally {
    submitBtn.disabled = false;
  }
}

function buildLabelItem(product, variant, retail, currency) {
  return {
    productName: product.name,
    variantLabel: [variant.size, variant.color].filter(Boolean).join(' / '),
    sku: variant.sku,
    barcode: variant.barcode,
    priceText: retail ? formatCents(retail.unit_price_cents, currency) : '',
  };
}

function renderVariantAddForm(product) {
  return `
    <form class="add-variant-form add-variant-form-target" data-product-id="${product.id}">
      <label>Size <input type="text" name="size" placeholder="e.g. M" /></label>
      <label>Color <input type="text" name="color" placeholder="e.g. Black" /></label>
      <label>SKU <input type="text" name="sku" required /></label>
      <label>Barcode <input type="text" name="barcode" /></label>
      <label>Location
        <select name="location_id">${locations.map((l) => `<option value="${l.id}">${l.name}</option>`).join('')}</select>
      </label>
      <label>Initial qty <input type="number" name="initial_qty" min="0" step="1" value="0" /></label>
      <button type="submit" class="primary">Add variant</button>
      <p class="error variant-error" style="grid-column: 1 / -1;"></p>
    </form>
  `;
}

async function renderProductList() {
  const client = getClient();
  const [{ data: products }, { data: variants }, { data: prices }, { data: balances }] = await Promise.all([
    client.from('products').select('*'),
    client.from('product_variants').select('*'),
    client.from('product_prices').select('*').order('effective_date', { ascending: false }),
    client.from('v_inventory_balances').select('*'),
  ]);

  const latestPrice = {};
  for (const p of prices ?? []) {
    const key = `${p.product_id}:${p.price_type}`;
    if (!latestPrice[key]) latestPrice[key] = p;
  }

  const variantsByProduct = {};
  for (const v of variants ?? []) {
    (variantsByProduct[v.product_id] ??= []).push(v);
  }

  const balancesByVariant = {};
  for (const b of balances ?? []) {
    (balancesByVariant[b.variant_id] ??= []).push(b);
  }

  const locationName = Object.fromEntries(locations.map((l) => [l.id, l.name]));

  const container = document.getElementById('product-list');
  container.innerHTML =
    (products ?? [])
      .map((p) => {
        const retail = latestPrice[`${p.id}:retail`];
        const wholesale = latestPrice[`${p.id}:wholesale`];
        const currency = retail?.currency ?? p.base_currency;
        const productVariants = variantsByProduct[p.id] ?? [];
        const totalStock = productVariants.reduce(
          (sum, v) => sum + (balancesByVariant[v.id] ?? []).reduce((s, b) => s + b.quantity_available, 0),
          0
        );
        const expanded = expandedProductId === p.id;

        const variantRows =
          productVariants
            .map((v) => {
              const stockByLoc = (balancesByVariant[v.id] ?? [])
                .map((b) => `${locationName[b.location_id] ?? '?'}: ${b.quantity_available}`)
                .join(' · ');
              return `
              <tr>
                <td>${v.size ?? '—'}</td>
                <td>${v.color ?? '—'}</td>
                <td>${v.sku}</td>
                <td>${v.barcode ?? '—'}</td>
                <td>${stockByLoc || '0'}</td>
                <td><button type="button" class="ghost print-label-btn" data-product-id="${p.id}" data-variant-id="${v.id}">Print label</button></td>
              </tr>`;
            })
            .join('') || '<tr><td colspan="6" style="color: var(--text-muted);">No variants yet — this product cannot be sold until one exists.</td></tr>';

        return `
        <div class="card product-card">
          <div class="product-card-header" data-id="${p.id}">
            ${p.image_url ? `<img class="product-thumb" src="${p.image_url}" alt="${p.name}" />` : ''}
            <span class="name">${p.name}</span>
            <span class="meta">${retail ? formatCents(retail.unit_price_cents, currency) : '—'}${wholesale ? ` / ${formatCents(wholesale.unit_price_cents, currency)} wholesale` : ''}</span>
            <span class="meta">${totalStock} in stock</span>
            <span class="meta">${productVariants.length} variant${productVariants.length === 1 ? '' : 's'}</span>
          </div>
          <div class="product-card-body" ${expanded ? '' : 'hidden'}>
            ${p.description ? `<p style="color: var(--text-muted); font-size: 0.9rem;">${p.description}</p>` : ''}
            <div class="price-edit-row">
              Retail <input type="number" min="0" step="0.01" class="edit-retail" value="${retail ? (retail.unit_price_cents / 100).toFixed(2) : ''}" />
              Wholesale <input type="number" min="0" step="0.01" class="edit-wholesale" value="${wholesale ? (wholesale.unit_price_cents / 100).toFixed(2) : ''}" />
              <button type="button" class="ghost save-price-btn" data-id="${p.id}" data-currency="${currency}">Update price</button>
            </div>
            <table class="variant-table">
              <thead><tr><th>Size</th><th>Color</th><th>SKU</th><th>Barcode</th><th>Stock by location</th><th></th></tr></thead>
              <tbody>${variantRows}</tbody>
            </table>
            ${productVariants.length > 0 ? `<button type="button" class="ghost print-all-labels-btn" data-id="${p.id}">Print all labels for this product</button>` : ''}
            <h2 style="font-size: 0.95rem; margin-top: 1rem;">Add a variant</h2>
            ${renderVariantAddForm(p)}
          </div>
        </div>`;
      })
      .join('') || '<p style="color: var(--text-muted);">No products yet — add one above.</p>';

  container.querySelectorAll('.product-card-header').forEach((header) => {
    header.addEventListener('click', () => {
      expandedProductId = expandedProductId === header.dataset.id ? null : header.dataset.id;
      renderProductList();
    });
  });
  container.querySelectorAll('.save-price-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.price-edit-row');
      const retailVal = row.querySelector('.edit-retail').value;
      const wholesaleVal = row.querySelector('.edit-wholesale').value;
      if (retailVal) await updatePrice(btn.dataset.id, 'retail', btn.dataset.currency, retailVal);
      if (wholesaleVal) await updatePrice(btn.dataset.id, 'wholesale', btn.dataset.currency, wholesaleVal);
    });
  });
  container.querySelectorAll('.print-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const product = (products ?? []).find((p) => p.id === btn.dataset.productId);
      const variant = (variants ?? []).find((v) => v.id === btn.dataset.variantId);
      const retail = latestPrice[`${product.id}:retail`];
      printLabels([buildLabelItem(product, variant, retail, retail?.currency ?? product.base_currency)]);
    });
  });
  container.querySelectorAll('.print-all-labels-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const product = (products ?? []).find((p) => p.id === btn.dataset.id);
      const retail = latestPrice[`${product.id}:retail`];
      const items = (variantsByProduct[product.id] ?? []).map((v) =>
        buildLabelItem(product, v, retail, retail?.currency ?? product.base_currency)
      );
      printLabels(items);
    });
  });
  container.querySelectorAll('.add-variant-form-target').forEach((form) => {
    const product = (products ?? []).find((p) => p.id === form.dataset.productId);
    // Prefill the SKU with a reasonable suggestion as size/color are typed, without
    // fighting a manual edit -- only auto-fill while the field is still untouched.
    let skuTouched = false;
    form.querySelector('[name="sku"]').addEventListener('input', () => {
      skuTouched = true;
    });
    const updateSuggestion = () => {
      if (skuTouched) return;
      const size = form.size.value.trim();
      const color = form.color.value.trim();
      form.sku.value = suggestSku(product.name.slice(0, 3).toUpperCase(), size, color, (variantsByProduct[product.id] ?? []).length);
    };
    form.size.addEventListener('input', updateSuggestion);
    form.color.addEventListener('input', updateSuggestion);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      handleAddVariant(product, form);
    });
  });
}

init();
