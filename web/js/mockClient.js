// Demo-mode stand-in for the Supabase client, used automatically (see supabaseClient.js)
// whenever js/config.js still has its placeholder project URL -- i.e. before a real
// Supabase project exists. Implements exactly the subset of the Supabase JS API this app
// actually calls (including `.storage.*`), backed by realistic seed data persisted to
// localStorage so a demo's actions -- a completed sale, a stock take, a new product --
// survive a page reload.
//
// This is a real dependency, not a footnote: swap-out is automatic. Fill in real values in
// config.js and this file stops being used entirely -- nothing else in web/ changes.
//
// SHAPE NOTE: this mirrors the real schema's product_variants model (see the
// product_variants migration) -- products carry name/description/currency/pricing/cost
// only; sku/barcode/physical stock live on product_variants. Every product has at least
// one variant, same as the real migration's zero-data-loss backfill guarantees.

const STATE_KEY = 'subtle-pos-demo-state-v3';
const SESSION_KEY = 'subtle-pos-demo-session-v1';

// Single location -- wholesale inventory (a separate stock location) was removed per
// explicit direction; wholesale PRICING (retail vs wholesale price tiers, min_wholesale_qty)
// is unaffected, see the remove_wholesale_location migration's header comment.
export const DEMO_LOCATIONS = [{ id: 'loc-shop', name: 'Subtle Accessories Shop' }];

const MANUAL_SUPPLIER_ID = 'supplier-manual';

// Any of these can sign in with any password. An email that doesn't match one of these
// still signs in -- as the owner -- so a live demo never gets derailed by a typo. Static
// identity fields only (email/name/role) -- the actual queryable, mutable user_profiles
// row (manager_pin, last_seen_at) lives in state.user_profiles, seeded from this list, so
// those mutations persist across reloads the same way every other table's writes do.
export const DEMO_ACCOUNTS = [
  { id: 'user-owner', email: 'owner@subtlepos.demo', full_name: 'Tendai Moyo', role: 'owner', primary_location_id: 'loc-shop' },
  { id: 'user-shop-manager', email: 'manager@subtlepos.demo', full_name: 'Rudo Chikwava', role: 'shop_manager', primary_location_id: 'loc-shop' },
  { id: 'user-wholesale-manager', email: 'wholesale@subtlepos.demo', full_name: 'Farai Ncube', role: 'wholesale_manager', primary_location_id: 'loc-shop' },
  { id: 'user-cashier', email: 'cashier@subtlepos.demo', full_name: 'Tapiwa Dube', role: 'cashier', primary_location_id: 'loc-shop' },
];

// Demo PINs so the manager-PIN discount-approval flow (step 9) is testable out of the box
// without first visiting a settings screen. Real deployments start with manager_pin null.
const DEMO_MANAGER_PINS = { 'user-owner': '1234', 'user-shop-manager': '5678' };

// Each product optionally lists variants (size/color/sku suffix/qty/reorder threshold). A
// product with no `variants` array gets exactly one default variant (size/color null),
// same as the real migration's backfill of pre-existing flat-SKU products. Quantities are
// all single-location now (the former loc-shop + loc-wholesale split was merged into one
// number per variant when the wholesale location was removed).
const PRODUCT_SEED = [
  {
    sku: 'SA-001',
    name: 'Leather Wallet',
    description: 'Full-grain leather bifold wallet.',
    retail: 1800,
    wholesale: 1200,
    cost: 900,
    variants: [
      { size: null, color: 'Brown', skuSuffix: 'BRN', qty: 82 },
      { size: null, color: 'Black', skuSuffix: 'BLK', qty: 80 },
    ],
  },
  { sku: 'SA-002', name: 'Aviator Sunglasses', description: 'UV400 mirrored lenses.', retail: 2200, wholesale: 1500, cost: 1100, qty: 118 },
  { sku: 'SA-003', name: 'Beaded Bracelet', description: 'Handmade glass-bead bracelet.', retail: 800, wholesale: 500, cost: 350, qty: 265 },
  { sku: 'SA-004', name: 'Phone Case — iPhone 14', description: 'Shock-absorbing silicone case.', retail: 1500, wholesale: 950, cost: 700, qty: 147 },
  { sku: 'SA-005', name: 'Canvas Tote Bag', description: 'Heavyweight cotton canvas tote.', retail: 2500, wholesale: 1700, cost: 1250, qty: 85 },
  { sku: 'SA-006', name: 'Stainless Steel Watch', description: 'Quartz movement, sapphire coating.', retail: 4500, wholesale: 3200, cost: 2400, qty: 55, reorderThreshold: 10 },
  { sku: 'SA-007', name: 'Hoop Earrings', description: 'Gold-plated stainless steel hoops.', retail: 1000, wholesale: 650, cost: 450, qty: 200 },
  {
    sku: 'SA-008',
    name: 'Leather Belt',
    description: 'Full-grain leather belt, brass buckle.',
    retail: 1600,
    wholesale: 1050,
    cost: 800,
    variants: [
      { size: 'S', color: null, skuSuffix: 'S', qty: 42 },
      { size: 'M', color: null, skuSuffix: 'M', qty: 49 },
      { size: 'L', color: null, skuSuffix: 'L', qty: 8, reorderThreshold: 10 }, // seeded already below threshold, so the low-stock badge has something to show out of the box
    ],
  },
  { sku: 'SA-009', name: 'Baseball Cap', description: 'Adjustable cotton twill cap.', retail: 1200, wholesale: 800, cost: 550, qty: 174 },
  {
    sku: 'SA-010',
    name: 'Silk Scarf',
    description: '100% silk, hand-rolled edges.',
    retail: 1900,
    wholesale: 1300,
    cost: 950,
    variants: [
      { size: null, color: 'Red', skuSuffix: 'RED', qty: 37, reorderThreshold: 15 },
      { size: null, color: 'Blue', skuSuffix: 'BLU', qty: 36, reorderThreshold: 15 },
    ],
  },
];

function buildSeed() {
  const products = [];
  const variants = [];
  const prices = [];
  const balances = [];
  const cost_history = [];

  PRODUCT_SEED.forEach((p, i) => {
    const productId = `prod-${i + 1}`;
    products.push({
      id: productId,
      name: p.name,
      description: p.description ?? null,
      category_id: null,
      base_currency: 'USD',
      min_wholesale_qty: 6,
      is_active: true,
      image_url: null,
    });
    prices.push({ product_id: productId, price_type: 'retail', unit_price_cents: p.retail, currency: 'USD', effective_date: '2026-01-01' });
    prices.push({ product_id: productId, price_type: 'wholesale', unit_price_cents: p.wholesale, currency: 'USD', effective_date: '2026-01-01' });
    cost_history.push({
      id: `cost-seed-${productId}`,
      product_id: productId,
      supplier_id: MANUAL_SUPPLIER_ID,
      unit_cost_cents: p.cost,
      currency: 'USD',
      effective_date: '2026-01-01',
      stock_receipt_id: null,
    });

    const variantDefs = p.variants ?? [{ size: null, color: null, skuSuffix: null, qty: p.qty, reorderThreshold: p.reorderThreshold }];
    variantDefs.forEach((v, vi) => {
      const variantId = `var-${productId}-${vi + 1}`;
      const sku = v.skuSuffix ? `${p.sku}-${v.skuSuffix}` : p.sku;
      variants.push({
        id: variantId,
        product_id: productId,
        size: v.size ?? null,
        color: v.color ?? null,
        sku,
        barcode: null,
        is_active: true,
        reorder_threshold: v.reorderThreshold ?? null,
      });
      balances.push({
        id: `bal-${variantId}-loc-shop`,
        variant_id: variantId,
        location_id: 'loc-shop',
        quantity_available: v.qty ?? 0,
        average_unit_cost_cents: p.cost,
        currency: 'USD',
        needs_review: false,
        needs_review_reason: null,
        updated_at: new Date().toISOString(),
      });
    });
  });

  return {
    products,
    variants,
    prices,
    balances,
    cost_history,
    suppliers: [{ id: MANUAL_SUPPLIER_ID, name: 'Manual Entry', contact_info: {}, voided_at: null }],
    stock_receipts: [],
    stock_receipt_items: [],
    stock_counts: [],
    stock_count_items: [],
    sales: [],
    sale_items: [],
    sale_payments: [],
    sale_item_returns: [],
    purchase_orders: [],
    purchase_order_items: [],
    inventory_transfers: [],
    user_profiles: DEMO_ACCOUNTS.map((a) => ({ ...a, manager_pin: DEMO_MANAGER_PINS[a.id] ?? null, last_seen_at: null })),
    app_settings: [{ key: 'manual_discount_cap_cents', value: 2000, updated_at: new Date().toISOString() }],
    discount_codes: [
      {
        id: 'discount-seed-1',
        code: 'WELCOME10',
        discount_type: 'percentage',
        discount_value: 10,
        min_spend_cents: 0,
        valid_from: '2026-01-01T00:00:00.000Z',
        valid_until: null,
        is_active: true,
        created_by: 'user-owner',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    activity_log: [],
    inventory_transfer_items: [],
    customers: [],
    imageStore: {},
  };
}

// Every array a fresh session might not have (added in a later pass than the one that
// created a still-cached localStorage state) needs a default -- otherwise an old demo
// session left over from before a feature existed would crash on load instead of just
// picking the new feature up cleanly.
function backfillShape(loaded) {
  const fresh = buildSeed();
  for (const key of Object.keys(fresh)) {
    if (!(key in loaded)) loaded[key] = Array.isArray(fresh[key]) ? [] : fresh[key];
  }
  return loaded;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return backfillShape(JSON.parse(raw));
  } catch (err) {
    console.warn('Demo state failed to load, reseeding:', err);
  }
  const seed = buildSeed();
  localStorage.setItem(STATE_KEY, JSON.stringify(seed));
  return seed;
}

function saveState(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

export function resetDemoData() {
  localStorage.removeItem(STATE_KEY);
  localStorage.removeItem(SESSION_KEY);
}

const state = loadState();

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(user) {
  if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  else localStorage.removeItem(SESSION_KEY);
}

function tableRows(table) {
  switch (table) {
    case 'products':
      return state.products;
    case 'product_variants':
      return state.variants;
    case 'product_prices':
      return state.prices;
    case 'product_cost_history':
      return state.cost_history;
    case 'suppliers':
      return state.suppliers;
    case 'stock_receipts':
      return state.stock_receipts;
    case 'stock_receipt_items':
      return state.stock_receipt_items;
    case 'stock_counts':
      return state.stock_counts;
    case 'stock_count_items':
      return state.stock_count_items;
    case 'v_inventory_balances':
      return state.balances;
    case 'locations':
      return DEMO_LOCATIONS;
    case 'user_profiles':
      return state.user_profiles;
    case 'app_settings':
      return state.app_settings;
    case 'discount_codes':
      return state.discount_codes;
    case 'activity_log':
      return state.activity_log;
    case 'sales':
      return state.sales;
    case 'sale_items':
    case 'v_sale_items':
      return state.sale_items;
    case 'sale_payments':
      return state.sale_payments;
    case 'sale_item_returns':
    case 'v_sale_item_returns':
      return state.sale_item_returns;
    case 'purchase_orders':
      return state.purchase_orders;
    case 'purchase_order_items':
      return state.purchase_order_items;
    case 'inventory_transfers':
      return state.inventory_transfers;
    case 'inventory_transfer_items':
      return state.inventory_transfer_items;
    case 'customers':
      return state.customers;
    default:
      return [];
  }
}

function findOrCreateBalance(variantId, locationId, currency) {
  let balance = state.balances.find((b) => b.variant_id === variantId && b.location_id === locationId);
  if (!balance) {
    balance = {
      id: `bal-${variantId}-${locationId}`,
      variant_id: variantId,
      location_id: locationId,
      quantity_available: 0,
      average_unit_cost_cents: 0,
      currency: currency ?? 'USD',
      needs_review: false,
      needs_review_reason: null,
      updated_at: new Date().toISOString(),
    };
    state.balances.push(balance);
  }
  return balance;
}

// Mirrors fn_populate_sale_item_cost_snapshot: looks up whatever product_cost_history row
// was in effect as of the parent sale's own created_at (not "now"), and freezes it onto the
// row -- exactly what the real BEFORE INSERT trigger does server-side, since a cashier's
// device can never be trusted (or, under RLS, even able) to know or send its own cost basis.
function populateSaleItemCostSnapshot(row, saleCreatedAt) {
  const variant = state.variants.find((v) => v.id === row.variant_id);
  if (!variant) throw new Error(`Unknown variant ${row.variant_id} for sale item`);
  const candidates = state.cost_history
    .filter((c) => c.product_id === variant.product_id && c.effective_date <= saleCreatedAt)
    .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1));
  const cost = candidates[0];
  if (!cost) {
    throw new Error(
      `No product_cost_history exists for product ${variant.product_id} (variant ${row.variant_id}) as of ${saleCreatedAt}; cannot record a sale with no cost basis to snapshot.`
    );
  }
  row.unit_cost_at_sale_cents = cost.unit_cost_cents;
  row.cost_of_goods_sold_cents = row.quantity * cost.unit_cost_cents;
  row.gross_profit_cents = row.quantity * row.unit_selling_price_cents - row.cost_of_goods_sold_cents;
}

// Mirrors fn_apply_sale_item_inventory_impact: decrement the selling location's stock the
// moment a sale_items row is written, so Inventory reflects a demo sale immediately.
function applySaleItemStockImpact(row) {
  const sale = state.sales.find((s) => s.id === row.sale_id);
  if (!sale) return;
  populateSaleItemCostSnapshot(row, sale.created_at);
  const balance = findOrCreateBalance(row.variant_id, sale.location_id, row.currency);
  balance.quantity_available -= row.quantity;
  balance.updated_at = new Date().toISOString();
}

// Mirrors fn_apply_stock_receipt_item: recompute the location's weighted-average cost and
// drop a product_cost_history row (still product_id-keyed -- cost is shared across a
// product's variants by design, see the product_variants migration), so admin-entered
// stock behaves exactly like a real stock receipt would against the live schema.
function applyStockReceiptItem(row) {
  const receipt = state.stock_receipts.find((r) => r.id === row.stock_receipt_id);
  if (!receipt) return;
  const variant = state.variants.find((v) => v.id === row.variant_id);
  if (!variant) return;
  const balance = findOrCreateBalance(row.variant_id, receipt.location_id, receipt.currency);

  const existingQty = balance.quantity_available;
  const existingAvg = balance.average_unit_cost_cents;
  const newQty = row.quantity;
  const newAvg =
    existingQty + newQty === 0
      ? 0
      : Math.round((existingQty * existingAvg + newQty * row.unit_landed_cost_cents) / (existingQty + newQty));

  balance.quantity_available = existingQty + newQty;
  balance.average_unit_cost_cents = newAvg;
  balance.updated_at = new Date().toISOString();

  state.cost_history.push({
    id: `cost-${crypto.randomUUID()}`,
    product_id: variant.product_id,
    supplier_id: receipt.supplier_id,
    unit_cost_cents: row.unit_landed_cost_cents,
    currency: receipt.currency,
    effective_date: new Date().toISOString(),
    stock_receipt_id: receipt.id,
  });
}

// Mirrors fn_apply_stock_count_completion: a stock take sets quantity_available to exactly
// what was physically counted, clearing any needs_review flag.
function applyStockCountCompletion(stockCountRow) {
  const items = state.stock_count_items.filter((i) => i.stock_count_id === stockCountRow.id);
  for (const item of items) {
    const balance = findOrCreateBalance(item.variant_id, stockCountRow.location_id);
    balance.quantity_available = item.counted_quantity;
    balance.needs_review = false;
    balance.needs_review_reason = null;
    balance.updated_at = new Date().toISOString();
  }
}

// Mirrors fn_apply_transfer_receipt: moves stock (and blends weighted-average cost) from
// the source location to the destination once a transfer reaches received/partially
// received. Deducts the source unconditionally -- by the time a transfer is marked
// received, the stock has already physically left the source location.
function applyTransferReceipt(transferRow) {
  const items = state.inventory_transfer_items.filter(
    (i) => i.inventory_transfer_id === transferRow.id && (i.quantity_received ?? 0) > 0
  );
  for (const item of items) {
    const fromBalance = findOrCreateBalance(item.variant_id, transferRow.from_location_id);
    fromBalance.quantity_available -= item.quantity_received;
    fromBalance.updated_at = new Date().toISOString();

    const toBalance = findOrCreateBalance(item.variant_id, transferRow.to_location_id);
    const existingQty = toBalance.quantity_available;
    const existingAvg = toBalance.average_unit_cost_cents;
    const incomingQty = item.quantity_received;
    const incomingCost = item.unit_cost_at_transfer_cents ?? 0;
    const newAvg =
      existingQty + incomingQty === 0
        ? 0
        : Math.round((existingQty * existingAvg + incomingQty * incomingCost) / (existingQty + incomingQty));
    toBalance.quantity_available = existingQty + incomingQty;
    toBalance.average_unit_cost_cents = newAvg;
    toBalance.updated_at = new Date().toISOString();
  }
}

// Mirrors fn_process_sale_item_return: validates the return quantity against what's still
// returnable, defaults restock_location_id to the original sale's location, and reverses
// COGS/gross profit using the ORIGINAL recorded unit cost -- never today's cost. Mutates
// `row` in place before it's stored, the same way a BEFORE INSERT trigger mutates NEW.
function processSaleItemReturn(row) {
  const saleItem = state.sale_items.find((i) => i.id === row.sale_item_id);
  if (!saleItem) throw new Error(`Unknown sale_item ${row.sale_item_id} for return`);

  const alreadyReturned = state.sale_item_returns
    .filter((r) => r.sale_item_id === row.sale_item_id)
    .reduce((sum, r) => sum + r.quantity_returned, 0);
  if (alreadyReturned + row.quantity_returned > saleItem.quantity) {
    throw new Error(
      `Cannot return ${row.quantity_returned} units: only ${saleItem.quantity - alreadyReturned} of ${saleItem.quantity} remain returnable`
    );
  }

  if (!row.restock_location_id) {
    const sale = state.sales.find((s) => s.id === saleItem.sale_id);
    row.restock_location_id = sale?.location_id ?? null;
  }

  row.cogs_reversed_cents = row.quantity_returned * saleItem.unit_cost_at_sale_cents;
  row.gross_profit_reversed_cents =
    row.quantity_returned * (saleItem.unit_selling_price_cents - saleItem.unit_cost_at_sale_cents);
}

// Mirrors fn_restock_sale_item_return: puts the returned quantity back into stock at
// whatever restock_location_id was resolved to above.
function restockSaleItemReturn(row) {
  const saleItem = state.sale_items.find((i) => i.id === row.sale_item_id);
  if (!saleItem) return;
  const balance = findOrCreateBalance(saleItem.variant_id, row.restock_location_id);
  balance.quantity_available += row.quantity_returned;
  balance.updated_at = new Date().toISOString();
}

function applyWrite(table, rows) {
  const target = tableRows(table);
  try {
    for (const row of rows) {
      // app_settings is keyed by `key`, not `id`, and needs real upsert-replace semantics
      // (the whole point is that the discount cap can be changed), not the
      // insert-once/ignore-duplicates behavior every other table here uses.
      if (table === 'app_settings') {
        const existing = target.find((r) => r.key === row.key);
        if (existing) Object.assign(existing, row);
        else target.push(row);
        continue;
      }
      if (target.find((r) => r.id === row.id)) continue; // upsert + ignoreDuplicates semantics
      if (table === 'sale_item_returns') processSaleItemReturn(row); // may throw; mutates row
      target.push(row);
      if (table === 'sale_items') applySaleItemStockImpact(row);
      if (table === 'stock_receipt_items') applyStockReceiptItem(row);
      if (table === 'stock_counts' && row.status === 'completed') applyStockCountCompletion(row);
      if (table === 'sale_item_returns') restockSaleItemReturn(row);
    }
  } catch (err) {
    return { data: null, error: { message: err.message } };
  }
  saveState(state);
  return { data: null, error: null };
}

function applyUpdate(table, patch, filters) {
  const target = tableRows(table);
  const matches = target.filter((r) => filters.every((f) => f(r)));
  for (const row of matches) {
    const wasCompleted = row.status === 'completed';
    const wasReceived = row.status === 'received' || row.status === 'partially_received';
    Object.assign(row, patch);
    if (table === 'stock_counts' && row.status === 'completed' && !wasCompleted) {
      applyStockCountCompletion(row);
    }
    if (table === 'inventory_transfers' && !wasReceived && (row.status === 'received' || row.status === 'partially_received')) {
      applyTransferReceipt(row);
    }
  }
  saveState(state);
  return { data: null, error: null };
}

class MockQuery {
  constructor(table) {
    this._table = table;
    this._filters = [];
    this._orderCol = null;
    this._orderAsc = true;
    this._single = false;
    this._write = null;
    this._updatePatch = null;
  }
  select() {
    return this;
  }
  eq(col, val) {
    this._filters.push((r) => r[col] === val);
    return this;
  }
  in(col, vals) {
    const set = new Set(vals);
    this._filters.push((r) => set.has(r[col]));
    return this;
  }
  order(col, opts = {}) {
    this._orderCol = col;
    this._orderAsc = opts.ascending !== false;
    return this;
  }
  single() {
    this._single = true;
    return this;
  }
  insert(rows) {
    this._write = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows) {
    this._write = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch) {
    this._updatePatch = patch;
    return this;
  }
  // Makes the builder itself awaitable, same shape as the real supabase-js client.
  then(resolve, reject) {
    this._run().then(resolve, reject);
  }
  async _run() {
    if (this._write) return applyWrite(this._table, this._write);
    if (this._updatePatch) return applyUpdate(this._table, this._updatePatch, this._filters);

    let rows = tableRows(this._table).filter((r) => this._filters.every((f) => f(r)));
    if (this._orderCol) {
      const col = this._orderCol;
      rows = rows.slice().sort((a, b) => {
        const cmp = a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0;
        return this._orderAsc ? cmp : -cmp;
      });
    }
    if (this._single) {
      return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'No matching row (demo data)' } };
    }
    return { data: rows, error: null };
  }
}

function fileToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(blob);
  });
}

// Stands in for Supabase Storage: "uploading" just base64-encodes the file into
// localStorage and "the public URL" is that data URL directly. Fine for a demo's scale;
// a real deployment uses the actual product-images bucket (see the admin_and_stock_take
// migration) instead of this.
function createMockStorage() {
  return {
    from(bucket) {
      return {
        async upload(path, fileOrBlob) {
          try {
            const dataUrl = await fileToDataUrl(fileOrBlob);
            state.imageStore[`${bucket}/${path}`] = dataUrl;
            saveState(state);
            return { data: { path }, error: null };
          } catch (err) {
            return { data: null, error: { message: err.message } };
          }
        },
        getPublicUrl(path) {
          return { data: { publicUrl: state.imageStore[`${bucket}/${path}`] ?? '' } };
        },
      };
    },
  };
}

export function createMockClient() {
  return {
    __isDemoClient: true,
    auth: {
      async signInWithPassword({ email }) {
        const match =
          DEMO_ACCOUNTS.find((u) => u.email.toLowerCase() === String(email ?? '').trim().toLowerCase()) ?? DEMO_ACCOUNTS[0];
        saveSession(match);
        return { data: { session: { user: { id: match.id } } }, error: null };
      },
      async getSession() {
        const user = loadSession();
        return { data: { session: user ? { user: { id: user.id } } : null } };
      },
      async signOut() {
        saveSession(null);
      },
    },
    from(table) {
      return new MockQuery(table);
    },
    storage: createMockStorage(),
    // Mirrors verify_manager_pin(): returns the matching manager/owner's id, or null --
    // never the PIN itself or which OTHER pins exist, matching the real RPC's contract.
    async rpc(fnName, params = {}) {
      if (fnName === 'verify_manager_pin') {
        const pin = params.p_pin;
        const match = pin
          ? state.user_profiles.find(
              (u) => u.manager_pin === pin && ['shop_manager', 'wholesale_manager', 'owner'].includes(u.role)
            )
          : null;
        return { data: match ? match.id : null, error: null };
      }
      return { data: null, error: { message: `Unknown RPC function in demo mode: ${fnName}` } };
    },
  };
}
