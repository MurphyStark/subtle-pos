import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { cacheProducts, getCachedProducts, cacheVariants, getCachedVariants, queueOutbox, countPendingOutbox } from './db.js';
import { initSyncListeners, replayOutbox } from './sync.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { showReceipt } from './receipt.js';
import { logActivity } from './activity.js';

// MVP simplification, flagged in the README: one currency and one payment method per sale.
// Split/multi-currency tender (sale_payments supports it) is a stretch goal, not built yet.
//
// STEP 4 of the fashion-retail evolution: reworked for product_variants. Price/cost stay
// at the product level (see that migration's header comment); identity, barcode, and
// stock all live on the variant. A product with exactly one variant skips the picker (the
// common case for a product with no real size/color variation); a product with more than
// one opens a picker. A search term that exactly matches a variant's barcode or SKU on
// Enter resolves straight to that variant and adds it, mirroring how a USB/Bluetooth
// barcode scanner behaves (types the code, then sends an Enter keystroke).

let profile = null;
let products = []; // [{ ...product fields, retail_price_cents, currency, variants: [...] }]
let cart = []; // [{ product, variant, quantity }]
let locationName = '';
let balancesByVariant = {}; // variant_id -> quantity_available at the CURRENT location, display-only

// STEP 9 (promotions): a manual discount above this cap needs a manager's PIN, verified
// against verify_manager_pin() at checkout time so the approving manager's id (not the PIN
// itself) can be recorded on the sale. Defaults to $20 if app_settings can't be reached
// (e.g. offline) -- a conservative fallback that just means PIN entry is asked for slightly
// more often than strictly necessary, never less.
let manualDiscountCapCents = 2000;
let appliedDiscountCode = null; // the matched discount_codes row, or null

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['cashier', 'shop_manager', 'wholesale_manager', 'owner', 'admin']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  await loadProducts();
  await loadLocationName();
  await loadDiscountCap();
  renderProductGrid();
  wireControls();

  initSyncListeners(refreshStatusBanner);
  window.addEventListener('online', refreshStatusBanner);
  window.addEventListener('offline', refreshStatusBanner);
  await refreshStatusBanner();
}

function buildSellableProducts(rawProducts, rawVariants) {
  const variantsByProduct = {};
  for (const v of rawVariants) {
    if (v.is_active === false) continue;
    (variantsByProduct[v.product_id] ??= []).push(v);
  }
  // A product with no variants isn't sellable yet -- see admin.html's own messaging.
  products = rawProducts.map((p) => ({ ...p, variants: variantsByProduct[p.id] ?? [] })).filter((p) => p.variants.length > 0);
}

async function loadBalances(client) {
  try {
    const { data } = await client
      .from('v_inventory_balances')
      .select('variant_id, location_id, quantity_available')
      .eq('location_id', profile.primary_location_id);
    balancesByVariant = Object.fromEntries((data ?? []).map((b) => [b.variant_id, b.quantity_available]));
  } catch {
    balancesByVariant = {}; // display-only -- checkout still works without stock counts shown
  }
}

async function loadProducts() {
  if (navigator.onLine) {
    try {
      const client = getClient();
      const { data: prods, error: prodError } = await client
        .from('products')
        .select('id, name, base_currency, is_active')
        .eq('is_active', true);
      if (prodError) throw prodError;

      const { data: variantRows, error: variantError } = await client
        .from('product_variants')
        .select('id, product_id, size, color, sku, barcode, is_active')
        .eq('is_active', true);
      if (variantError) throw variantError;

      const { data: prices, error: priceError } = await client
        .from('product_prices')
        .select('product_id, price_type, unit_price_cents, currency, effective_date')
        .order('effective_date', { ascending: false });
      if (priceError) throw priceError;

      const latest = {};
      for (const p of prices) {
        const key = `${p.product_id}:${p.price_type}`;
        if (!latest[key]) latest[key] = p; // already sorted newest-first
      }

      // Price baked directly onto the cached product row, same pattern this file used
      // before variants existed -- the offline fallback just reads these back as-is.
      const enrichedProducts = prods.map((p) => ({
        ...p,
        retail_price_cents: latest[`${p.id}:retail`]?.unit_price_cents ?? null,
        currency: latest[`${p.id}:retail`]?.currency ?? p.base_currency,
      }));

      await cacheProducts(enrichedProducts);
      await cacheVariants(variantRows);
      await loadBalances(client);

      buildSellableProducts(enrichedProducts, variantRows);
      return;
    } catch (err) {
      console.warn('Could not fetch products online, falling back to cache:', err);
    }
  }
  const [cachedProducts, cachedVariants] = await Promise.all([getCachedProducts(), getCachedVariants()]);
  buildSellableProducts(cachedProducts, cachedVariants);
}

async function loadLocationName() {
  try {
    const client = getClient();
    const { data } = await client.from('locations').select('id, name').eq('id', profile.primary_location_id).single();
    locationName = data?.name ?? '';
  } catch {
    locationName = '';
  }
}

async function loadDiscountCap() {
  try {
    const client = getClient();
    const { data } = await client.from('app_settings').select('key, value').eq('key', 'manual_discount_cap_cents');
    if (data?.[0]?.value != null) manualDiscountCapCents = Number(data[0].value);
  } catch {
    // keep the conservative default set above
  }
}

// A code is looked up fresh from the server rather than cached, same reasoning as
// resolveCustomerId below -- it needs an authoritative is_active/valid_until check, so
// there's no safe offline fallback. Unlike the customer lookup, though, skipping a discount
// isn't harmless to silently do -- so applying a code is simply unavailable while offline.
async function handleApplyDiscountCode() {
  const input = document.getElementById('discount-code-input');
  const status = document.getElementById('discount-code-status');
  const code = input.value.trim().toUpperCase();
  status.textContent = '';
  appliedDiscountCode = null;

  if (!code) {
    renderTotals();
    return;
  }
  if (!navigator.onLine) {
    status.textContent = 'Discount codes need an internet connection to verify.';
    renderTotals();
    return;
  }

  try {
    const client = getClient();
    const { data } = await client.from('discount_codes').select('*').eq('code', code);
    const row = data?.[0];
    const now = new Date();
    if (!row || !row.is_active) {
      status.textContent = 'That code is not valid.';
    } else if (row.valid_from && new Date(row.valid_from) > now) {
      status.textContent = 'That code is not active yet.';
    } else if (row.valid_until && new Date(row.valid_until) < now) {
      status.textContent = 'That code has expired.';
    } else {
      const subtotalCents = cart.reduce((sum, l) => sum + currentPriceCents(l.product) * l.quantity, 0);
      if (row.min_spend_cents && subtotalCents < row.min_spend_cents) {
        status.textContent = `Needs a minimum spend of ${formatCents(row.min_spend_cents, 'USD')}.`;
      } else {
        appliedDiscountCode = row;
        status.textContent = `Code "${row.code}" applied.`;
      }
    }
  } catch (err) {
    status.textContent = err.message ?? 'Could not check that code.';
  }
  renderTotals();
}

function discountCodeCents(subtotalCents) {
  if (!appliedDiscountCode) return 0;
  const raw =
    appliedDiscountCode.discount_type === 'percentage'
      ? Math.round((subtotalCents * appliedDiscountCode.discount_value) / 100)
      : appliedDiscountCode.discount_value;
  return Math.min(subtotalCents, raw);
}

function currentPriceCents(product) {
  return product.retail_price_cents;
}

function variantLabel(variant) {
  return [variant.size, variant.color].filter(Boolean).join(' / ');
}

function renderProductGrid(filter = '') {
  const grid = document.getElementById('product-grid');
  const term = filter.trim().toLowerCase();
  const visible = products.filter((p) => {
    if (currentPriceCents(p) == null) return false; // no price set for this sale type
    if (!term) return true;
    if (p.name.toLowerCase().includes(term)) return true;
    return p.variants.some((v) => (v.sku ?? '').toLowerCase().includes(term) || (v.barcode ?? '').toLowerCase() === term);
  });

  grid.innerHTML = visible
    .map(
      (p) => `
      <button type="button" class="product-tile" data-id="${p.id}">
        <span class="name">${p.name}</span>
        <span class="price">${formatCents(currentPriceCents(p), p.currency)}</span>
        ${p.variants.length > 1 ? `<span class="variant-count">${p.variants.length} options</span>` : ''}
      </button>`
    )
    .join('');

  grid.querySelectorAll('.product-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const product = products.find((p) => p.id === tile.dataset.id);
      if (!product) return;
      if (product.variants.length === 1) {
        addVariantToCart(product, product.variants[0]);
      } else {
        showVariantPicker(product);
      }
    });
  });
}

function showVariantPicker(product) {
  const existing = document.getElementById('variant-picker-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'variant-picker-overlay';
  overlay.className = 'variant-picker-overlay';
  overlay.innerHTML = `
    <div class="variant-picker-card">
      <h2>${product.name}</h2>
      <p style="color: var(--text-muted); font-size: 0.85rem; margin-top: -0.5rem;">Choose an option</p>
      <div class="variant-picker-options">
        ${product.variants
          .map((v) => {
            const label = variantLabel(v) || v.sku;
            const qty = balancesByVariant[v.id];
            return `<button type="button" class="variant-option-btn" data-variant-id="${v.id}">
              <span>${label}</span>
              ${qty != null ? `<span class="variant-qty">${qty} in stock</span>` : ''}
            </button>`;
          })
          .join('')}
      </div>
      <button type="button" class="ghost" id="variant-picker-cancel" style="width: 100%;">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelectorAll('.variant-option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const variant = product.variants.find((v) => v.id === btn.dataset.variantId);
      addVariantToCart(product, variant);
      overlay.remove();
    });
  });
  document.getElementById('variant-picker-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function addVariantToCart(product, variant) {
  const existing = cart.find((line) => line.variant.id === variant.id);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ product, variant, quantity: 1 });
  }
  renderCart();
}

// Mirrors how a USB/Bluetooth barcode scanner behaves: types the full code, then sends an
// Enter keystroke. An exact barcode (or SKU) match resolves straight to that variant --
// no picker needed, since scanning already identifies the specific size/color.
function tryResolveExactScan(term) {
  const trimmed = term.trim();
  if (!trimmed) return false;
  for (const p of products) {
    const variant = p.variants.find((v) => v.barcode === trimmed || v.sku === trimmed);
    if (variant) {
      addVariantToCart(p, variant);
      return true;
    }
  }
  return false;
}

function setQuantity(variantId, quantity) {
  const line = cart.find((l) => l.variant.id === variantId);
  if (!line) return;
  if (quantity <= 0) {
    cart = cart.filter((l) => l.variant.id !== variantId);
  } else {
    line.quantity = quantity;
  }
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cart-lines');

  const linesHtml =
    cart
      .map((line) => {
        const label = variantLabel(line.variant);
        return `
      <div class="cart-line" data-id="${line.variant.id}">
        <div>
          <div>${line.product.name}${label ? ` — ${label}` : ''}</div>
          <div style="color: var(--text-muted); font-size: 0.8rem;">
            ${formatCents(currentPriceCents(line.product), line.product.currency)} each
          </div>
        </div>
        <div class="qty-controls">
          <button type="button" class="ghost qty-minus">−</button>
          <span>${line.quantity}</span>
          <button type="button" class="ghost qty-plus">+</button>
        </div>
      </div>`;
      })
      .join('') || '<p style="color: var(--text-muted);">Cart is empty — tap a product to add it.</p>';

  container.innerHTML = linesHtml;

  container.querySelectorAll('.cart-line').forEach((el) => {
    const id = el.dataset.id;
    const line = cart.find((l) => l.variant.id === id);
    el.querySelector('.qty-plus').addEventListener('click', () => setQuantity(id, line.quantity + 1));
    el.querySelector('.qty-minus').addEventListener('click', () => setQuantity(id, line.quantity - 1));
  });

  renderTotals();
}

function renderTotals() {
  const subtotalCents = cart.reduce((sum, l) => sum + currentPriceCents(l.product) * l.quantity, 0);
  const manualDiscountCents = Math.max(0, toCents(document.getElementById('cart-discount').value || 0));
  const totalDiscountCents = Math.min(subtotalCents, manualDiscountCents + discountCodeCents(subtotalCents));
  const taxCents = Math.max(0, toCents(document.getElementById('cart-tax').value || 0));
  const totalCents = Math.max(0, subtotalCents - totalDiscountCents + taxCents);
  const currency = cart[0]?.product.currency ?? 'USD';

  document.getElementById('cart-subtotal').textContent = formatCents(subtotalCents, currency);
  document.getElementById('cart-total').textContent = formatCents(totalCents, currency);
  document.getElementById('manager-pin-row').hidden = manualDiscountCents <= manualDiscountCapCents;

  document.getElementById('checkout-btn').disabled = cart.length === 0;
}

function wireControls() {
  const searchInput = document.getElementById('product-search');
  searchInput.addEventListener('input', (e) => renderProductGrid(e.target.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (tryResolveExactScan(searchInput.value)) {
      searchInput.value = '';
      renderProductGrid('');
    }
  });

  document.getElementById('cart-discount').addEventListener('input', renderTotals);
  document.getElementById('cart-tax').addEventListener('input', renderTotals);
  document.getElementById('apply-discount-code-btn').addEventListener('click', handleApplyDiscountCode);

  document.getElementById('checkout-btn').addEventListener('click', completeSale);
}

// STEP 8: customer lookup/attach at checkout. Deliberately online-only -- unlike the sale
// itself (which always queues and syncs later), finding-or-creating a customer needs a
// real round trip to check for a phone match, and skipping it while offline is harmless:
// the sale still completes and syncs normally, just without a customer_id attached.
async function resolveCustomerId(client) {
  const name = document.getElementById('customer-name').value.trim();
  const phone = document.getElementById('customer-phone').value.trim();
  if (!name && !phone) return null;
  if (!navigator.onLine) return null;

  try {
    if (phone) {
      const { data: existing } = await client.from('customers').select('id').eq('phone', phone);
      if (existing?.[0]) return existing[0].id;
    }
    const id = crypto.randomUUID();
    await client.from('customers').insert({ id, name: name || 'Walk-in customer', phone: phone || null });
    return id;
  } catch {
    return null; // a customer-lookup hiccup should never block the sale itself
  }
}

async function completeSale() {
  const errorEl = document.getElementById('checkout-error');
  errorEl.textContent = '';
  if (cart.length === 0) return;

  const currency = cart[0].product.currency ?? 'USD';
  const subtotalCents = cart.reduce((sum, l) => sum + currentPriceCents(l.product) * l.quantity, 0);
  const manualDiscountCents = Math.max(0, toCents(document.getElementById('cart-discount').value || 0));
  const taxCents = Math.max(0, toCents(document.getElementById('cart-tax').value || 0));
  const paymentMethod = document.getElementById('payment-method').value;

  // A manual discount above the cap needs a manager's PIN -- verified here (not just
  // hidden/shown in the UI) so bypassing the input can't skip the check. Resolves to the
  // approving manager's own id, which gets recorded on the sale; the PIN itself never does.
  let approvingManagerId = null;
  if (manualDiscountCents > manualDiscountCapCents) {
    if (!navigator.onLine) {
      errorEl.textContent = 'This discount needs manager approval, which requires an internet connection to verify.';
      return;
    }
    const pin = document.getElementById('manager-pin-input').value.trim();
    if (!pin) {
      errorEl.textContent = 'Enter the manager PIN to approve this discount.';
      return;
    }
    const { data: managerId, error: pinError } = await getClient().rpc('verify_manager_pin', { p_pin: pin });
    if (pinError || !managerId) {
      errorEl.textContent = 'That manager PIN was not recognized.';
      return;
    }
    approvingManagerId = managerId;
    await logActivity(
      profile,
      'manual_discount_approved',
      `A manager approved a manual discount of ${formatCents(manualDiscountCents, currency)} for ${profile.full_name}'s sale`,
      { approved_by: approvingManagerId, amount_cents: manualDiscountCents }
    );
  }

  const discountCents = Math.min(subtotalCents, manualDiscountCents + discountCodeCents(subtotalCents));
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents);
  const customerId = navigator.onLine ? await resolveCustomerId(getClient()) : null;

  const saleId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const sale = {
    id: saleId,
    location_id: profile.primary_location_id,
    cashier_id: profile.id,
    sale_type: 'retail', // checkout no longer offers a wholesale toggle -- wholesale PRICING (product_prices.price_type) is untouched, just not selectable at the till any more
    currency,
    subtotal_cents: subtotalCents,
    discount_cents: discountCents,
    tax_cents: taxCents,
    total_cents: totalCents,
    customer_id: customerId,
    discount_code: appliedDiscountCode?.code ?? null,
    discount_approved_by: approvingManagerId,
    created_at: nowIso, // the sale's OWN moment -- what the cost-snapshot trigger keys off
  };

  // unit_cost_at_sale_cents is intentionally NOT included -- the server populates it (via
  // variant_id -> product_id -> product_cost_history). See fn_populate_sale_item_cost_snapshot
  // in the sales_and_returns / product_variants migrations.
  const items = cart.map((line) => ({
    id: crypto.randomUUID(),
    variant_id: line.variant.id,
    quantity: line.quantity,
    unit_selling_price_cents: currentPriceCents(line.product),
    currency,
  }));

  const payments = [
    {
      id: crypto.randomUUID(),
      method: paymentMethod,
      currency,
      amount_cents: totalCents,
    },
  ];

  const checkoutBtn = document.getElementById('checkout-btn');
  checkoutBtn.disabled = true;

  try {
    if (navigator.onLine) {
      const client = getClient();
      // upsert + ignoreDuplicates (== INSERT ... ON CONFLICT DO NOTHING) makes this safe to
      // retry: if sale_items or sale_payments fails after the sale row already landed, the
      // outbox fallback below re-sends everything, and re-inserting the same id is then a
      // harmless no-op instead of a primary-key conflict.
      const { error: saleError } = await client
        .from('sales')
        .upsert({ ...sale, sync_status: 'synced' }, { onConflict: 'id', ignoreDuplicates: true });
      if (saleError) throw saleError;
      const { error: itemsError } = await client
        .from('sale_items')
        .upsert(items.map((i) => ({ ...i, sale_id: saleId })), { onConflict: 'id', ignoreDuplicates: true });
      if (itemsError) throw itemsError;
      const { error: paymentsError } = await client
        .from('sale_payments')
        .upsert(payments.map((p) => ({ ...p, sale_id: saleId })), { onConflict: 'id', ignoreDuplicates: true });
      if (paymentsError) throw paymentsError;
    } else {
      throw new Error('offline'); // fall through to the offline queue below
    }
  } catch (err) {
    // Online-but-failed and offline both land here: queue locally either way. The sale
    // already happened at the counter -- it must not be lost because of a network blip.
    await queueOutbox({
      id: saleId,
      entity_type: 'sale',
      entity_id: saleId,
      status: 'pending',
      created_at: nowIso,
      payload: { sale, items, payments },
    });
  }

  const receiptLines = cart.map((line) => ({
    name: line.product.name,
    variantLabel: variantLabel(line.variant),
    quantity: line.quantity,
    unitPriceCents: currentPriceCents(line.product),
  }));

  await logActivity(
    profile,
    'sale',
    `${profile.full_name} completed a sale of ${formatCents(totalCents, currency)}`,
    { sale_id: saleId, total_cents: totalCents, currency, item_count: items.length }
  );

  cart = [];
  appliedDiscountCode = null;
  document.getElementById('cart-discount').value = 0;
  document.getElementById('cart-tax').value = 0;
  document.getElementById('discount-code-input').value = '';
  document.getElementById('discount-code-status').textContent = '';
  document.getElementById('manager-pin-input').value = '';
  document.getElementById('manager-pin-row').hidden = true;
  document.getElementById('customer-name').value = '';
  document.getElementById('customer-phone').value = '';
  renderCart();
  await refreshStatusBanner();
  replayOutbox(refreshStatusBanner);

  showReceipt({ sale, lines: receiptLines, locationName, cashierName: profile.full_name });
}

async function refreshStatusBanner() {
  const banner = document.getElementById('status-banner');
  const pending = await countPendingOutbox();

  if (!navigator.onLine) {
    banner.innerHTML = `<div class="status-banner offline">Offline — sales are being saved on this device${
      pending ? ` (${pending} queued)` : ''
    } and will sync automatically once you're back online.</div>`;
  } else if (pending > 0) {
    banner.innerHTML = `<div class="status-banner pending">Syncing ${pending} queued sale${pending === 1 ? '' : 's'}…</div>`;
  } else {
    banner.innerHTML = '';
  }
}

init();
