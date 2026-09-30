import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { resizeImage } from './image.js';
import { printLabels } from './labels.js';
import { logActivity } from './activity.js';
import { icon } from './icons.js';
import { thumb, stockStatus, stockPill } from './ui.js';
import { loadCatalog, variantLabel, getOrCreateManualSupplier, receiveStock } from './catalog.js';

// Add a product (product.html) or edit one (product.html?id=...). Managers/owner/admin only.
//
// Price and cost live on the PRODUCT (shared by all its variants -- see the
// product_variants migration); identity, barcode and stock live on each variant. Price and
// cost changes are appended to product_prices / product_cost_history (never overwritten),
// so past sales keep the price and cost they were made at.
//
// When adding, variants can be listed before the product exists -- they're created right
// after it on save. When editing, adding a variant saves it immediately.
let profile = null;
let catalog = null;
let product = null; // the product being edited, or null when adding
let draftVariants = []; // add mode only
let pendingImage = null; // a File chosen but not yet uploaded
let removeImage = false;

const form = () => document.getElementById('product-form');

async function init() {
  registerServiceWorker();
  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner', 'admin']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  catalog = await loadCatalog(getClient());
  const id = new URLSearchParams(location.search).get('id');
  if (id) {
    product = catalog.productById[id];
    if (!product) {
      document.getElementById('page-error').textContent = 'That product could not be found.';
      form().hidden = true;
      return;
    }
  }

  const f = form();
  f.category_id.innerHTML = `<option value="">Choose a category</option>${catalog.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}`;
  if (product) fillForm(product);

  document.getElementById('photo-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    pendingImage = file;
    removeImage = false;
    renderImage();
  });
  document.getElementById('remove-image').addEventListener('click', () => {
    pendingImage = null;
    removeImage = true;
    document.getElementById('photo-input').value = '';
    renderImage();
  });
  document.getElementById('add-variant-btn').addEventListener('click', openVariantForm);
  f.addEventListener('submit', save);
  f.addEventListener('input', (e) => e.target.removeAttribute?.('aria-invalid'));
  document.getElementById('archive-product').addEventListener('click', archiveProduct);

  if (new URLSearchParams(location.search).get('created')) {
    document.getElementById('save-success').textContent = `${product.name} added.${product.variants.length ? '' : ' Add at least one variant so it can be sold.'}`;
  }

  renderImage();
  renderVariants();
}

function fillForm(p) {
  document.title = `Subtle POS — ${p.name}`;
  document.getElementById('product-title').textContent = 'Edit product';
  document.getElementById('product-subtitle').textContent = 'Update the product details, pricing and variants.';
  document.getElementById('save-btn').textContent = 'Save changes';
  document.getElementById('archive-product').hidden = false;
  const f = form();
  f.name.value = p.name;
  f.category_id.value = p.category_id ?? '';
  f.brand.value = p.brand ?? '';
  f.currency.value = p.retail?.currency ?? p.base_currency ?? 'USD';
  f.retail_price.value = p.retail ? (p.retail.unit_price_cents / 100).toFixed(2) : '';
  f.wholesale_price.value = p.wholesale ? (p.wholesale.unit_price_cents / 100).toFixed(2) : '';
  f.description.value = p.description ?? '';
  f.cost_price.value = p.cost ? (p.cost.unit_cost_cents / 100).toFixed(2) : '';
  f.min_wholesale_qty.value = p.min_wholesale_qty ?? 6;
  f.cost_price.required = false; // an existing product already has a cost basis
}

function renderImage() {
  const frame = document.getElementById('image-frame');
  if (pendingImage) {
    frame.innerHTML = `<img src="${URL.createObjectURL(pendingImage)}" alt="New product image" />`;
  } else if (!removeImage && product?.image_url) {
    frame.innerHTML = `<img src="${product.image_url}" alt="${product.name}" />`;
  } else {
    frame.innerHTML = `<span class="image-empty">${icon('image', { size: 40 })}<span>No image yet</span></span>`;
  }
  document.getElementById('remove-image').disabled = !pendingImage && (removeImage || !product?.image_url);
}

// ---------- variants ----------
function suggestSku(size, color) {
  const base = (form().name.value.trim() || 'ITEM').replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase();
  const parts = ['SUB', base];
  if (color) parts.push(color.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase());
  if (size) parts.push(size.toUpperCase().replace(/\s+/g, ''));
  if (!size && !color) parts.push(String((product?.variants.length ?? draftVariants.length) + 1).padStart(2, '0'));
  return parts.join('-');
}

function openVariantForm() {
  const slot = document.getElementById('variant-form-slot');
  if (slot.innerHTML) return slot.querySelector('input')?.focus();
  slot.innerHTML = `
    <div class="inline-form" role="group" aria-label="New variant">
      <div class="form-grid">
        <label>Colour<input type="text" data-field="color" placeholder="e.g. Rose Pink" /></label>
        <label>Size<input type="text" data-field="size" placeholder="e.g. 1.18L" /></label>
        <label>SKU <span class="req">*</span><input type="text" data-field="sku" /></label>
        <label>Barcode<input type="text" data-field="barcode" placeholder="optional" /></label>
        <label>Initial stock<input type="number" data-field="qty" min="0" step="1" value="0" /></label>
        <label>Stock location<select data-field="location_id">${catalog.locations.map((l) => `<option value="${l.id}" ${l.id === profile.primary_location_id ? 'selected' : ''}>${l.name}</option>`).join('')}</select></label>
        <label>Low stock at<input type="number" data-field="reorder" min="0" step="1" placeholder="default 2" /></label>
      </div>
      <p class="error" id="variant-error"></p>
      <div class="inline-form-actions">
        <button type="button" class="ghost" id="variant-cancel">Cancel</button>
        <button type="button" class="primary" id="variant-save">Add variant</button>
      </div>
    </div>`;
  const get = (k) => slot.querySelector(`[data-field="${k}"]`);
  let skuTouched = false;
  get('sku').addEventListener('input', () => (skuTouched = true));
  const suggest = () => {
    if (!skuTouched) get('sku').value = suggestSku(get('size').value.trim(), get('color').value.trim());
  };
  get('color').addEventListener('input', suggest);
  get('size').addEventListener('input', suggest);
  suggest();
  get('color').focus();
  document.getElementById('variant-cancel').addEventListener('click', () => (slot.innerHTML = ''));
  document.getElementById('variant-save').addEventListener('click', async () => {
    const errorEl = document.getElementById('variant-error');
    errorEl.textContent = '';
    const v = {
      color: get('color').value.trim() || null,
      size: get('size').value.trim() || null,
      sku: get('sku').value.trim().toUpperCase(),
      barcode: get('barcode').value.trim() || null,
      qty: Math.max(0, Math.floor(Number(get('qty').value) || 0)),
      location_id: get('location_id').value,
      reorder: get('reorder').value.trim() === '' ? null : Math.max(0, Math.floor(Number(get('reorder').value))),
    };
    if (!v.sku) return (errorEl.textContent = 'A SKU is required.');
    const taken = Object.values(catalog.variantById).some((x) => x.sku === v.sku) || draftVariants.some((x) => x.sku === v.sku);
    if (taken) return (errorEl.textContent = `SKU ${v.sku} is already used.`);

    if (!product) {
      draftVariants.push(v);
      slot.innerHTML = '';
      return renderVariants();
    }
    const btn = document.getElementById('variant-save');
    btn.disabled = true;
    try {
      await createVariant(getClient(), product, v);
      catalog = await loadCatalog(getClient());
      product = catalog.productById[product.id];
      slot.innerHTML = '';
      renderVariants();
    } catch (err) {
      errorEl.textContent = err.message ?? String(err);
      btn.disabled = false;
    }
  });
}

async function createVariant(client, forProduct, v) {
  const variantId = crypto.randomUUID();
  const { error } = await client.from('product_variants').insert({
    id: variantId,
    product_id: forProduct.id,
    size: v.size,
    color: v.color,
    sku: v.sku,
    barcode: v.barcode,
    is_active: true,
    reorder_threshold: v.reorder,
  });
  if (error) throw new Error(error.message);
  if (v.qty > 0) {
    // Initial stock arrives as a stock receipt at the product's current cost.
    const { data: costRows } = await client
      .from('product_cost_history')
      .select('unit_cost_cents, currency, effective_date')
      .eq('product_id', forProduct.id)
      .order('effective_date', { ascending: false });
    const cost = costRows?.[0];
    if (!cost) throw new Error('This product has no cost price yet, so stock cannot be received for it.');
    await receiveStock(client, { variantId, locationId: v.location_id, quantity: v.qty, unitCostCents: cost.unit_cost_cents, currency: cost.currency, createdBy: profile.id, notes: 'Initial stock' });
  }
  await logActivity(profile, 'stock_change', `${profile.full_name} added variant ${v.sku} to "${forProduct.name}"${v.qty ? ` with ${v.qty} units` : ''}`, {
    product_id: forProduct.id,
    variant_id: variantId,
    initial_qty: v.qty,
  });
}

function renderVariants() {
  const head = document.getElementById('variant-head');
  const body = document.getElementById('variant-body');
  if (!product) {
    head.innerHTML = '<tr><th>Variant</th><th>Colour</th><th>Size</th><th>SKU</th><th class="num">Initial stock</th><th></th></tr>';
    body.innerHTML =
      draftVariants
        .map(
          (v, i) => `
        <tr>
          <td><strong>${variantLabel(v) || 'Standard'}</strong></td>
          <td class="muted">${v.color ?? '—'}</td>
          <td class="muted">${v.size ?? '—'}</td>
          <td class="muted nowrap">${v.sku}</td>
          <td class="num">${v.qty}</td>
          <td><div class="row-actions"><button type="button" class="icon-btn danger" data-remove="${i}" aria-label="Remove ${v.sku}">${icon('trash', { size: 16 })}</button></div></td>
        </tr>`
        )
        .join('') || '<tr><td colspan="6" class="muted" style="text-align: center; padding: 24px;">No variants yet. Add at least one (for example each colour) so the product can be sold.</td></tr>';
    body.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        draftVariants.splice(Number(b.dataset.remove), 1);
        renderVariants();
      })
    );
    return;
  }

  const active = product.variants.filter((v) => v.is_active !== false);
  head.innerHTML = `<tr><th>Variant</th><th>SKU</th><th class="num">Price</th><th class="num">Stock</th><th>Status</th><th></th></tr>`;
  body.innerHTML =
    active
      .map((v) => {
        const qty = catalog.qty(v.id);
        return `
        <tr>
          <td><a class="cell-product" href="variant.html?id=${v.id}">${thumb(product.image_url, '', 'sm')}<span><span class="name">${variantLabel(v) || 'Standard'}</span>${v.barcode ? `<span class="sub">Barcode ${v.barcode}</span>` : ''}</span></a></td>
          <td class="muted nowrap">${v.sku}</td>
          <td class="num">${product.retail ? formatCents(product.retail.unit_price_cents, product.retail.currency) : '—'}</td>
          <td class="num">${qty}</td>
          <td>${stockPill(stockStatus(qty, v.reorder_threshold))}</td>
          <td><div class="row-actions">
            <a class="icon-btn" href="variant.html?id=${v.id}" aria-label="Details for ${v.sku}" title="Stock & history">${icon('chevronRight', { size: 16 })}</a>
            <button type="button" class="icon-btn" data-label="${v.id}" aria-label="Print label for ${v.sku}" title="Print label">${icon('printer', { size: 16 })}</button>
            <button type="button" class="icon-btn danger" data-archive="${v.id}" aria-label="Remove ${v.sku}" title="Remove">${icon('trash', { size: 16 })}</button>
          </div></td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="6" class="muted" style="text-align: center; padding: 24px;">No variants yet — this product cannot be sold until one exists.</td></tr>';

  if (active.length > 1) {
    body.insertAdjacentHTML('beforeend', `<tr><td colspan="6"><button type="button" class="ghost" id="print-all-labels">${icon('printer', { size: 16 })} Print all labels</button></td></tr>`);
    document.getElementById('print-all-labels').addEventListener('click', () => printLabels(active.map(labelItem)));
  }
  body.querySelectorAll('[data-label]').forEach((b) => b.addEventListener('click', () => printLabels([labelItem(catalog.variantById[b.dataset.label])])));
  body.querySelectorAll('[data-archive]').forEach((b) => b.addEventListener('click', () => archiveVariant(catalog.variantById[b.dataset.archive])));
}

function labelItem(variant) {
  return {
    productName: product.name,
    variantLabel: variantLabel(variant),
    sku: variant.sku,
    barcode: variant.barcode,
    priceText: product.retail ? formatCents(product.retail.unit_price_cents, product.retail.currency) : '',
  };
}

// Variants and products are never hard-deleted: sales, counts and receipts reference them.
// "Removing" one hides it from checkout and stock takes; its history stays intact.
async function archiveVariant(variant) {
  if (!confirm(`Remove ${variant.sku} (${variantLabel(variant) || 'Standard'})? It will no longer be sold or counted. Its sales and stock history are kept.`)) return;
  const { error } = await getClient().from('product_variants').update({ is_active: false }).eq('id', variant.id);
  if (error) return (document.getElementById('page-error').textContent = error.message);
  await logActivity(profile, 'product_updated', `${profile.full_name} removed variant ${variant.sku} from "${product.name}"`, { product_id: product.id, variant_id: variant.id });
  catalog = await loadCatalog(getClient());
  product = catalog.productById[product.id];
  renderVariants();
}

async function archiveProduct() {
  if (!confirm(`Delete "${product.name}"? It will be removed from checkout and the product list. Sales and stock history are kept.`)) return;
  const { error } = await getClient().from('products').update({ is_active: false }).eq('id', product.id);
  if (error) return (document.getElementById('page-error').textContent = error.message);
  await logActivity(profile, 'product_updated', `${profile.full_name} deleted product "${product.name}"`, { product_id: product.id });
  location.href = 'admin.html';
}

// ---------- save ----------
async function uploadProductPhoto(client, file, productId) {
  const blob = await resizeImage(file);
  const path = `${productId}.jpg`;
  const { error } = await client.storage.from('product-images').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
  if (error) throw new Error(error.message);
  return client.storage.from('product-images').getPublicUrl(path).data.publicUrl;
}

function validate(f) {
  const problems = [];
  if (!f.name.value.trim()) problems.push([f.name, 'Enter a product name.']);
  if (catalog.categories.length && !f.category_id.value) problems.push([f.category_id, 'Choose a category.']);
  if (f.retail_price.value === '' || Number(f.retail_price.value) < 0) problems.push([f.retail_price, 'Enter a retail price.']);
  if (!product && (f.cost_price.value === '' || Number(f.cost_price.value) < 0)) problems.push([f.cost_price, 'Enter the cost price, so profit can be worked out.']);
  f.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  problems.forEach(([el]) => el.setAttribute('aria-invalid', 'true'));
  if (problems.length) problems[0][0].focus();
  return problems.map(([, msg]) => msg);
}

async function save(event) {
  event.preventDefault();
  const f = form();
  const errorEl = document.getElementById('page-error');
  const successEl = document.getElementById('save-success');
  errorEl.textContent = '';
  successEl.textContent = '';
  const problems = validate(f);
  if (problems.length) return (errorEl.textContent = problems.join(' '));

  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  const client = getClient();
  const currency = f.currency.value;
  const now = new Date().toISOString();
  const fields = {
    name: f.name.value.trim(),
    category_id: f.category_id.value || null,
    brand: f.brand.value.trim() || null,
    description: f.description.value.trim() || null,
    min_wholesale_qty: Math.max(1, Number(f.min_wholesale_qty.value) || 1),
  };

  try {
    if (!product) {
      const productId = crypto.randomUUID();
      const { error } = await client.from('products').insert({ id: productId, ...fields, base_currency: currency, is_active: true });
      if (error) throw new Error(error.message);
      // id and effective_date carry DB defaults the demo mock doesn't replicate -- set them
      // explicitly so rows don't collide and "latest by effective_date" is meaningful.
      const priceRows = [{ id: crypto.randomUUID(), product_id: productId, price_type: 'retail', unit_price_cents: toCents(f.retail_price.value), currency, effective_date: now }];
      if (f.wholesale_price.value) priceRows.push({ id: crypto.randomUUID(), product_id: productId, price_type: 'wholesale', unit_price_cents: toCents(f.wholesale_price.value), currency, effective_date: now });
      await client.from('product_prices').insert(priceRows);
      await client.from('product_cost_history').insert({
        id: crypto.randomUUID(),
        product_id: productId,
        supplier_id: await getOrCreateManualSupplier(client),
        unit_cost_cents: toCents(f.cost_price.value),
        currency,
        effective_date: now,
      });
      if (pendingImage) await client.from('products').update({ image_url: await uploadProductPhoto(client, pendingImage, productId) }).eq('id', productId);
      const created = { id: productId, name: fields.name };
      for (const v of draftVariants) await createVariant(client, created, v);
      await logActivity(profile, 'product_created', `${profile.full_name} created product "${fields.name}"`, { product_id: productId });
      location.href = `product.html?id=${productId}&created=1`;
      return;
    }

    const { error } = await client.from('products').update(fields).eq('id', product.id);
    if (error) throw new Error(error.message);
    const changes = [];
    const priceCurrency = product.retail?.currency ?? currency;
    const retail = toCents(f.retail_price.value);
    if (retail !== product.retail?.unit_price_cents) {
      await client.from('product_prices').insert({ id: crypto.randomUUID(), product_id: product.id, price_type: 'retail', unit_price_cents: retail, currency: priceCurrency, effective_date: now });
      changes.push(`retail price ${formatCents(retail, priceCurrency)}`);
    }
    if (f.wholesale_price.value !== '') {
      const wholesale = toCents(f.wholesale_price.value);
      if (wholesale !== product.wholesale?.unit_price_cents) {
        await client.from('product_prices').insert({ id: crypto.randomUUID(), product_id: product.id, price_type: 'wholesale', unit_price_cents: wholesale, currency: priceCurrency, effective_date: now });
        changes.push(`wholesale price ${formatCents(wholesale, priceCurrency)}`);
      }
    }
    if (f.cost_price.value !== '') {
      const cost = toCents(f.cost_price.value);
      if (cost !== product.cost?.unit_cost_cents) {
        await client.from('product_cost_history').insert({ id: crypto.randomUUID(), product_id: product.id, supplier_id: await getOrCreateManualSupplier(client), unit_cost_cents: cost, currency: priceCurrency, effective_date: now });
        changes.push('cost price');
      }
    }
    if (pendingImage) await client.from('products').update({ image_url: await uploadProductPhoto(client, pendingImage, product.id) }).eq('id', product.id);
    else if (removeImage) await client.from('products').update({ image_url: null }).eq('id', product.id);

    await logActivity(profile, 'product_updated', `${profile.full_name} updated "${fields.name}"${changes.length ? ` (${changes.join(', ')})` : ''}`, { product_id: product.id });
    catalog = await loadCatalog(client);
    product = catalog.productById[product.id];
    pendingImage = null;
    removeImage = false;
    fillForm(product);
    renderImage();
    renderVariants();
    successEl.textContent = 'Changes saved.';
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  } finally {
    btn.disabled = false;
  }
}

init();
