import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { cacheProducts, getCachedProducts, queueOutbox, countPendingOutbox } from './db.js';
import { initSyncListeners, replayOutbox } from './sync.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// MVP simplification, flagged in the README: one currency and one payment method per sale.
// Split/multi-currency tender (sale_payments supports it) is a stretch goal, not built yet.

let profile = null;
let products = [];
let cart = []; // [{ product, quantity }]
let saleType = 'retail';

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['cashier', 'shop_manager', 'wholesale_manager', 'owner']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  await loadProducts();
  renderProductGrid();
  wireControls();

  initSyncListeners(refreshStatusBanner);
  window.addEventListener('online', refreshStatusBanner);
  window.addEventListener('offline', refreshStatusBanner);
  await refreshStatusBanner();
}

async function loadProducts() {
  if (navigator.onLine) {
    try {
      const client = getClient();
      const { data: prods, error: prodError } = await client
        .from('products')
        .select('id, sku, barcode, name, base_currency, min_wholesale_qty, is_active')
        .eq('is_active', true);
      if (prodError) throw prodError;

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

      products = prods.map((p) => ({
        ...p,
        retail_price_cents: latest[`${p.id}:retail`]?.unit_price_cents ?? null,
        wholesale_price_cents: latest[`${p.id}:wholesale`]?.unit_price_cents ?? null,
        currency: latest[`${p.id}:retail`]?.currency ?? p.base_currency,
      }));
      await cacheProducts(products);
      return;
    } catch (err) {
      console.warn('Could not fetch products online, falling back to cache:', err);
    }
  }
  products = await getCachedProducts();
}

function currentPriceCents(product) {
  return saleType === 'wholesale' ? product.wholesale_price_cents : product.retail_price_cents;
}

function renderProductGrid(filter = '') {
  const grid = document.getElementById('product-grid');
  const term = filter.trim().toLowerCase();
  const visible = products.filter((p) => {
    if (currentPriceCents(p) == null) return false; // no price set for this sale type
    if (!term) return true;
    return (
      p.name.toLowerCase().includes(term) ||
      p.sku.toLowerCase().includes(term) ||
      (p.barcode ?? '').toLowerCase() === term
    );
  });

  grid.innerHTML = visible
    .map(
      (p) => `
      <button type="button" class="product-tile" data-id="${p.id}">
        <span class="name">${p.name}</span>
        <span class="price">${formatCents(currentPriceCents(p), p.currency)}</span>
      </button>`
    )
    .join('');

  grid.querySelectorAll('.product-tile').forEach((tile) => {
    tile.addEventListener('click', () => addToCart(tile.dataset.id));
  });
}

function addToCart(productId) {
  const product = products.find((p) => p.id === productId);
  if (!product) return;

  const existing = cart.find((line) => line.product.id === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ product, quantity: 1 });
  }
  renderCart();
}

function setQuantity(productId, quantity) {
  const line = cart.find((l) => l.product.id === productId);
  if (!line) return;
  if (quantity <= 0) {
    cart = cart.filter((l) => l.product.id !== productId);
  } else {
    line.quantity = quantity;
  }
  renderCart();
}

function renderCart() {
  const container = document.getElementById('cart-lines');

  const belowMinimumLine =
    saleType === 'wholesale' ? cart.find((l) => l.quantity < (l.product.min_wholesale_qty ?? 1)) : null;
  const warningHtml = belowMinimumLine
    ? `<p class="error">
        ${belowMinimumLine.product.name} needs manager approval below its minimum wholesale
        quantity of ${belowMinimumLine.product.min_wholesale_qty}. That approval flow isn't
        built yet -- adjust the quantity or switch to Retail for now.
      </p>`
    : '';

  const linesHtml =
    cart
      .map(
        (line) => `
      <div class="cart-line" data-id="${line.product.id}">
        <div>
          <div>${line.product.name}</div>
          <div style="color: var(--text-muted); font-size: 0.8rem;">
            ${formatCents(currentPriceCents(line.product), line.product.currency)} each
          </div>
        </div>
        <div class="qty-controls">
          <button type="button" class="ghost qty-minus">−</button>
          <span>${line.quantity}</span>
          <button type="button" class="ghost qty-plus">+</button>
        </div>
      </div>`
      )
      .join('') || '<p style="color: var(--text-muted);">Cart is empty — tap a product to add it.</p>';

  container.innerHTML = warningHtml + linesHtml;

  container.querySelectorAll('.cart-line').forEach((el) => {
    const id = el.dataset.id;
    const line = cart.find((l) => l.product.id === id);
    el.querySelector('.qty-plus').addEventListener('click', () => setQuantity(id, line.quantity + 1));
    el.querySelector('.qty-minus').addEventListener('click', () => setQuantity(id, line.quantity - 1));
  });

  renderTotals();
}

function renderTotals() {
  const subtotalCents = cart.reduce((sum, l) => sum + currentPriceCents(l.product) * l.quantity, 0);
  const discountCents = Math.max(0, toCents(document.getElementById('cart-discount').value || 0));
  const taxCents = Math.max(0, toCents(document.getElementById('cart-tax').value || 0));
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents);
  const currency = cart[0]?.product.currency ?? 'USD';

  document.getElementById('cart-subtotal').textContent = formatCents(subtotalCents, currency);
  document.getElementById('cart-total').textContent = formatCents(totalCents, currency);

  const belowMinimum =
    saleType === 'wholesale' && cart.some((l) => l.quantity < (l.product.min_wholesale_qty ?? 1));
  document.getElementById('checkout-btn').disabled = cart.length === 0 || belowMinimum;
}

function wireControls() {
  document.getElementById('product-search').addEventListener('input', (e) => renderProductGrid(e.target.value));
  document.getElementById('cart-discount').addEventListener('input', renderTotals);
  document.getElementById('cart-tax').addEventListener('input', renderTotals);

  document.getElementById('type-retail').addEventListener('click', () => setSaleType('retail'));
  document.getElementById('type-wholesale').addEventListener('click', () => setSaleType('wholesale'));

  document.getElementById('checkout-btn').addEventListener('click', completeSale);
}

function setSaleType(type) {
  saleType = type;
  document.getElementById('type-retail').classList.toggle('active', type === 'retail');
  document.getElementById('type-wholesale').classList.toggle('active', type === 'wholesale');
  renderProductGrid(document.getElementById('product-search').value);
  renderCart();
}

async function completeSale() {
  const errorEl = document.getElementById('checkout-error');
  errorEl.textContent = '';
  if (cart.length === 0) return;

  const currency = cart[0].product.currency ?? 'USD';
  const subtotalCents = cart.reduce((sum, l) => sum + currentPriceCents(l.product) * l.quantity, 0);
  const discountCents = Math.max(0, toCents(document.getElementById('cart-discount').value || 0));
  const taxCents = Math.max(0, toCents(document.getElementById('cart-tax').value || 0));
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents);
  const paymentMethod = document.getElementById('payment-method').value;

  const saleId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  const sale = {
    id: saleId,
    location_id: profile.primary_location_id,
    cashier_id: profile.id,
    sale_type: saleType,
    currency,
    subtotal_cents: subtotalCents,
    discount_cents: discountCents,
    tax_cents: taxCents,
    total_cents: totalCents,
    created_at: nowIso, // the sale's OWN moment -- what the cost-snapshot trigger keys off
  };

  // unit_cost_at_sale_cents is intentionally NOT included -- the server populates it. See
  // fn_populate_sale_item_cost_snapshot in the sales_and_returns migration.
  const items = cart.map((line) => ({
    id: crypto.randomUUID(),
    product_id: line.product.id,
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

  cart = [];
  document.getElementById('cart-discount').value = 0;
  document.getElementById('cart-tax').value = 0;
  renderCart();
  await refreshStatusBanner();
  replayOutbox(refreshStatusBanner);
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
