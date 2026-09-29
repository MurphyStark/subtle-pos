import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { resizeImage } from './image.js';
import { printLabels } from './labels.js';
import { logActivity } from './activity.js';
import { icon } from './icons.js';
import { thumb, stockStatus, stockPill, renderPagination } from './ui.js';

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
let categories = [];
// Products-table view state: search, filters and page survive re-renders after an edit.
const view = { term: '', category: '', status: '', page: 1 };
let catalog = null; // last fetched { products, variants, latestPrice, balancesByVariant }

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner', 'admin']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  const client = getClient();
  const [{ data: locs }, { data: cats }] = await Promise.all([
    client.from('locations').select('id, name'),
    client.from('categories').select('id, name').order('name'),
  ]);
  locations = locs ?? [];
  categories = cats ?? [];

  const categoryOptions = categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
  document.getElementById('filter-category').innerHTML = `<option value="">All categories</option>${categoryOptions}`;
  document.querySelector('#product-form select[name="category_id"]').innerHTML = `<option value="">No category</option>${categoryOptions}`;
  wireProductToolbar();

  document.querySelector('input[name="photo"]').addEventListener('change', previewPhoto);
  document.getElementById('product-form').addEventListener('submit', handleCreateProduct);
  document.getElementById('discount-code-form').addEventListener('submit', handleCreateDiscountCode);
  document.getElementById('pin-form').addEventListener('submit', handleSetManagerPin);

  await renderProductList();
  await renderDiscountCodesList();
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
      category_id: form.category_id.value || null,
      base_currency: currency,
      min_wholesale_qty: Number(form.min_wholesale_qty.value) || 1,
      is_active: true,
    });

    // id and effective_date both carry DB defaults (gen_random_uuid()/now()) in the real
    // schema, which the demo mock does not replicate -- set them explicitly so a second
    // product's price/cost rows don't collide with the first's under the mock's
    // upsert-by-id dedup (see mockClient.js's applyWrite), and so "latest by effective_date"
    // ordering is meaningful instead of comparing undefined to undefined.
    const priceEffectiveDate = new Date().toISOString();
    const priceRows = [
      { id: crypto.randomUUID(), product_id: productId, price_type: 'retail', unit_price_cents: toCents(form.retail_price.value), currency, effective_date: priceEffectiveDate },
    ];
    if (form.wholesale_price.value) {
      priceRows.push({ id: crypto.randomUUID(), product_id: productId, price_type: 'wholesale', unit_price_cents: toCents(form.wholesale_price.value), currency, effective_date: priceEffectiveDate });
    }
    await client.from('product_prices').insert(priceRows);

    // Cost basis lives at the product level (shared across variants) -- inserted directly
    // since there's no stock receipt at product-creation time any more (stock now arrives
    // per-variant, added below via "add a variant").
    const supplierId = await getOrCreateManualSupplier(client);
    await client.from('product_cost_history').insert({
      id: crypto.randomUUID(),
      product_id: productId,
      supplier_id: supplierId,
      unit_cost_cents: toCents(form.cost_price.value),
      currency,
      effective_date: priceEffectiveDate,
    });

    const photoFile = form.photo.files?.[0];
    if (photoFile) {
      const imageUrl = await uploadProductPhoto(client, photoFile, productId);
      await client.from('products').update({ image_url: imageUrl }).eq('id', productId);
    }

    successEl.textContent = `${form.name.value.trim()} added — now add at least one variant below so it can be sold.`;
    await logActivity(profile, 'product_created', `${profile.full_name} created product "${form.name.value.trim()}"`, { product_id: productId });
    form.reset();
    document.getElementById('photo-preview').innerHTML = '';
    expandedProductId = productId;
    view.term = '';
    view.page = 1;
    document.getElementById('product-search').value = '';
    await renderProductList();
    document.querySelector('.expanded-row')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  await client.from('product_prices').insert({ id: crypto.randomUUID(), product_id: productId, price_type: priceType, unit_price_cents: cents, currency, effective_date: new Date().toISOString() });
  await logActivity(profile, 'price_updated', `${profile.full_name} updated the ${priceType} price to ${formatCents(cents, currency)}`, { product_id: productId, price_type: priceType, unit_price_cents: cents });
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
    const reorderThresholdInput = form.reorder_threshold.value.trim();
    const reorderThreshold = reorderThresholdInput ? Number(reorderThresholdInput) : null;

    if (!sku) throw new Error('SKU is required.');

    await client.from('product_variants').insert({
      id: variantId,
      product_id: product.id,
      size,
      color,
      sku,
      barcode,
      is_active: true,
      reorder_threshold: reorderThreshold,
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

    await logActivity(
      profile,
      'stock_change',
      `${profile.full_name} added variant ${sku} to "${product.name}"${quantity > 0 ? ` with ${quantity} units` : ''}`,
      { product_id: product.id, variant_id: variantId, initial_qty: quantity }
    );

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
      <label>Reorder at <input type="number" name="reorder_threshold" min="0" step="1" placeholder="optional" /></label>
      <button type="submit" class="primary">Add variant</button>
      <p class="error variant-error" style="grid-column: 1 / -1;"></p>
    </form>
  `;
}

function wireProductToolbar() {
  const search = document.getElementById('product-search');
  search.addEventListener('input', () => {
    view.term = search.value.trim().toLowerCase();
    view.page = 1;
    drawProductTable();
  });
  document.getElementById('filter-category').addEventListener('change', (e) => {
    view.category = e.target.value;
    view.page = 1;
    drawProductTable();
  });
  document.getElementById('filter-status').addEventListener('change', (e) => {
    view.status = e.target.value;
    view.page = 1;
    drawProductTable();
  });
  const addPanel = document.getElementById('add-product-panel');
  document.getElementById('toggle-add-product').addEventListener('click', () => {
    addPanel.hidden = !addPanel.hidden;
    if (!addPanel.hidden) addPanel.querySelector('input[name="name"]').focus();
  });
  document.getElementById('cancel-add-product').addEventListener('click', () => {
    addPanel.hidden = true;
  });
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

  const categoryName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  catalog = {
    products: (products ?? [])
      .map((p) => {
        const productVariants = variantsByProduct[p.id] ?? [];
        const totalStock = productVariants.reduce(
          (sum, v) => sum + (balancesByVariant[v.id] ?? []).reduce((s, b) => s + b.quantity_available, 0),
          0
        );
        return {
          ...p,
          variants: productVariants,
          categoryName: categoryName[p.category_id] ?? '',
          totalStock,
          status: productVariants.length ? stockStatus(totalStock) : 'out',
        };
      })
      .sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.name.localeCompare(b.name)),
    variants: variants ?? [],
    latestPrice,
    balancesByVariant,
  };
  drawProductTable();
}

function drawProductTable() {
  const { latestPrice, balancesByVariant } = catalog;
  const locationName = Object.fromEntries(locations.map((l) => [l.id, l.name]));

  const filtered = catalog.products.filter((p) => {
    if (view.category && p.category_id !== view.category) return false;
    if (view.status && p.status !== view.status) return false;
    if (!view.term) return true;
    return p.name.toLowerCase().includes(view.term) || p.variants.some((v) => (v.sku ?? '').toLowerCase().includes(view.term) || (v.barcode ?? '') === view.term);
  });
  // An expanded product stays on screen: jump to its page.
  const expandedIndex = filtered.findIndex((p) => p.id === expandedProductId);
  if (expandedIndex >= 0) view.page = Math.floor(expandedIndex / 10) + 1;

  const { from, to, page } = renderPagination(document.getElementById('product-pagination'), {
    total: filtered.length,
    page: view.page,
    noun: 'products',
    onPage: (n) => {
      view.page = n;
      expandedProductId = null;
      drawProductTable();
    },
  });
  view.page = page;

  const tbody = document.getElementById('product-list');
  tbody.innerHTML =
    filtered
      .slice(from, to)
      .map((p) => {
        const retail = latestPrice[`${p.id}:retail`];
        const wholesale = latestPrice[`${p.id}:wholesale`];
        const currency = retail?.currency ?? p.base_currency;
        const expanded = expandedProductId === p.id;

        const variantRows =
          p.variants
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
                <td>${v.reorder_threshold ?? '—'}</td>
                <td><button type="button" class="ghost print-label-btn" data-product-id="${p.id}" data-variant-id="${v.id}">${icon('printer', { size: 16 })} Label</button></td>
              </tr>`;
            })
            .join('') || '<tr><td colspan="7" class="muted">No variants yet — this product cannot be sold until one exists.</td></tr>';

        return `
        <tr class="product-row" data-id="${p.id}">
          <td><div class="cell-product">${thumb(p.image_url, '', 'md')}<span class="name">${p.name}</span></div></td>
          <td class="muted">${p.categoryName || '—'}</td>
          <td>${p.variants.length}</td>
          <td class="muted nowrap">${p.variants[0]?.sku ?? '—'}</td>
          <td class="num">${retail ? formatCents(retail.unit_price_cents, currency) : '—'}</td>
          <td class="num">${p.totalStock}</td>
          <td>${stockPill(p.status)}</td>
          <td><div class="row-actions">
            <button type="button" class="icon-btn edit-product-btn" aria-expanded="${expanded}" aria-label="Edit ${p.name}" title="Edit">${icon('pencil', { size: 16 })}</button>
          </div></td>
        </tr>
        ${
          expanded
            ? `<tr class="expanded-row"><td colspan="8">
            ${p.description ? `<p class="muted" style="margin-top: 0;">${p.description}</p>` : ''}
            <div class="price-edit-row">
              Retail <input type="number" min="0" step="0.01" class="edit-retail" value="${retail ? (retail.unit_price_cents / 100).toFixed(2) : ''}" />
              Wholesale <input type="number" min="0" step="0.01" class="edit-wholesale" value="${wholesale ? (wholesale.unit_price_cents / 100).toFixed(2) : ''}" />
              <button type="button" class="ghost save-price-btn" data-id="${p.id}" data-currency="${currency}">Update price</button>
            </div>
            <div class="table-wrap"><table class="variant-table">
              <thead><tr><th>Size</th><th>Colour</th><th>SKU</th><th>Barcode</th><th>Stock by location</th><th>Reorder at</th><th></th></tr></thead>
              <tbody>${variantRows}</tbody>
            </table></div>
            ${p.variants.length > 0 ? `<button type="button" class="ghost print-all-labels-btn" data-id="${p.id}">${icon('printer', { size: 16 })} Print all labels for this product</button>` : ''}
            <h2 style="font-size: 15px; margin-top: 18px;">Add a variant</h2>
            ${renderVariantAddForm(p)}
          </td></tr>`
            : ''
        }`;
      })
      .join('') || '<tr><td colspan="8" class="muted" style="text-align: center; padding: 32px;">No products match these filters.</td></tr>';

  const products = catalog.products;
  const variants = catalog.variants;
  const variantsByProduct = Object.fromEntries(products.map((p) => [p.id, p.variants]));

  tbody.querySelectorAll('.product-row').forEach((row) => {
    row.addEventListener('click', () => {
      expandedProductId = expandedProductId === row.dataset.id ? null : row.dataset.id;
      drawProductTable();
    });
  });
  tbody.querySelectorAll('.save-price-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.price-edit-row');
      const retailVal = row.querySelector('.edit-retail').value;
      const wholesaleVal = row.querySelector('.edit-wholesale').value;
      if (retailVal) await updatePrice(btn.dataset.id, 'retail', btn.dataset.currency, retailVal);
      if (wholesaleVal) await updatePrice(btn.dataset.id, 'wholesale', btn.dataset.currency, wholesaleVal);
    });
  });
  tbody.querySelectorAll('.print-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const product = products.find((p) => p.id === btn.dataset.productId);
      const variant = variants.find((v) => v.id === btn.dataset.variantId);
      const retail = latestPrice[`${product.id}:retail`];
      printLabels([buildLabelItem(product, variant, retail, retail?.currency ?? product.base_currency)]);
    });
  });
  tbody.querySelectorAll('.print-all-labels-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const product = products.find((p) => p.id === btn.dataset.id);
      const retail = latestPrice[`${product.id}:retail`];
      const items = (variantsByProduct[product.id] ?? []).map((v) =>
        buildLabelItem(product, v, retail, retail?.currency ?? product.base_currency)
      );
      printLabels(items);
    });
  });
  tbody.querySelectorAll('.add-variant-form-target').forEach((form) => {
    const product = products.find((p) => p.id === form.dataset.productId);
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

// STEP 9 of the fashion-retail evolution (promotions). Any manager/owner can create/toggle
// codes -- RLS on discount_codes mirrors the products tables (is_manager_or_owner()).
// Values are stored as cents/whole-percent under the hood but entered as dollars/percent
// here, same convention as product prices.
async function renderDiscountCodesList() {
  const client = getClient();
  const { data: codes } = await client.from('discount_codes').select('*').order('created_at', { ascending: false });
  const tbody = document.getElementById('discount-code-list-body');

  tbody.innerHTML =
    (codes ?? [])
      .map((c) => {
        const value = c.discount_type === 'percentage' ? `${c.discount_value}%` : formatCents(c.discount_value, 'USD');
        const minSpend = c.min_spend_cents ? formatCents(c.min_spend_cents, 'USD') : '—';
        const validUntil = c.valid_until ? new Date(c.valid_until).toLocaleDateString() : '—';
        return `
        <tr>
          <td>${c.code}</td>
          <td>${c.discount_type}</td>
          <td>${value}</td>
          <td>${minSpend}</td>
          <td>${validUntil}</td>
          <td>${c.is_active ? 'Yes' : 'No'}</td>
          <td><button type="button" class="ghost toggle-discount-btn" data-id="${c.id}" data-active="${c.is_active}">${c.is_active ? 'Deactivate' : 'Activate'}</button></td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="7" style="color: var(--text-muted);">No discount codes yet.</td></tr>';

  tbody.querySelectorAll('.toggle-discount-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleToggleDiscountCode(btn.dataset.id, btn.dataset.active === 'true'));
  });
}

async function handleCreateDiscountCode(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('discount-code-error');
  errorEl.textContent = '';
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const client = getClient();
    const code = form.code.value.trim().toUpperCase();
    const discountType = form.discount_type.value;
    // Percentage is a whole-number percent (e.g. 10 = 10%); fixed amount is a dollar value
    // converted to cents -- same unit-storage split discount_type implies in the migration.
    const discountValue = discountType === 'percentage' ? Number(form.discount_value.value) : toCents(form.discount_value.value);
    const minSpend = form.min_spend.value ? toCents(form.min_spend.value) : null;
    const validUntil = form.valid_until.value || null;

    if (!code) throw new Error('Code is required.');

    await client.from('discount_codes').insert({
      id: crypto.randomUUID(),
      code,
      discount_type: discountType,
      discount_value: discountValue,
      min_spend_cents: minSpend,
      valid_until: validUntil,
      is_active: true,
      created_by: profile.id,
      created_at: new Date().toISOString(),
    });

    await logActivity(profile, 'discount_code_created', `${profile.full_name} created discount code ${code}`, { code });
    form.reset();
    await renderDiscountCodesList();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleToggleDiscountCode(id, currentlyActive) {
  const client = getClient();
  await client.from('discount_codes').update({ is_active: !currentlyActive }).eq('id', id);
  await logActivity(profile, 'discount_code_updated', `${profile.full_name} ${currentlyActive ? 'deactivated' : 'activated'} a discount code`, { discount_code_id: id });
  await renderDiscountCodesList();
}

// Self-service PIN: a manager/owner sets their OWN pin (updates their own user_profiles
// row), never someone else's -- there's no "set another user's PIN" UI, deliberately, since
// verify_manager_pin() only needs to know a PIN belongs to *some* manager/owner, not which
// row set it from where.
async function handleSetManagerPin(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('pin-error');
  const successEl = document.getElementById('pin-success');
  errorEl.textContent = '';
  successEl.textContent = '';
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const pin = form.pin.value.trim();
    if (!/^[0-9]{4,6}$/.test(pin)) throw new Error('PIN must be 4-6 digits.');

    const client = getClient();
    const { error } = await client.from('user_profiles').update({ manager_pin: pin }).eq('id', profile.id);
    if (error) throw error;

    successEl.textContent = 'PIN saved.';
    form.reset();
  } catch (err) {
    // The partial unique index on user_profiles.manager_pin surfaces as a generic
    // constraint-violation error from Postgres -- give the manager a plain-language reason
    // rather than a raw DB error, since "someone else already has this PIN" is the only
    // realistic cause.
    errorEl.textContent = /unique|duplicate/i.test(err.message ?? '') ? 'That PIN is already in use — choose a different one.' : (err.message ?? String(err));
  } finally {
    submitBtn.disabled = false;
  }
}

init();
