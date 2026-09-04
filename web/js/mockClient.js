// Demo-mode stand-in for the Supabase client, used automatically (see supabaseClient.js)
// whenever js/config.js still has its placeholder project URL -- i.e. before a real
// Supabase project exists. Implements exactly the subset of the Supabase JS API this app
// actually calls (verified against every `.from(...)` / `.auth.*` call site in web/js/),
// backed by realistic seed data persisted to localStorage so a demo's actions -- a
// completed sale, a stock decrement -- survive a page reload.
//
// This is a real dependency, not a footnote: swap-out is automatic. Fill in real values in
// config.js and this file stops being used entirely -- nothing else in web/ changes.

const STATE_KEY = 'subtle-pos-demo-state-v1';
const SESSION_KEY = 'subtle-pos-demo-session-v1';

export const DEMO_LOCATIONS = [
  { id: 'loc-shop', name: 'Subtle Accessories Shop' },
  { id: 'loc-wholesale', name: 'Home / Wholesale Store' },
];

// Any of these can sign in with any password. An email that doesn't match one of these
// still signs in -- as the owner -- so a live demo never gets derailed by a typo.
export const DEMO_ACCOUNTS = [
  { id: 'user-owner', email: 'owner@subtlepos.demo', full_name: 'Tendai Moyo', role: 'owner', primary_location_id: 'loc-shop' },
  { id: 'user-shop-manager', email: 'manager@subtlepos.demo', full_name: 'Rudo Chikwava', role: 'shop_manager', primary_location_id: 'loc-shop' },
  { id: 'user-wholesale-manager', email: 'wholesale@subtlepos.demo', full_name: 'Farai Ncube', role: 'wholesale_manager', primary_location_id: 'loc-wholesale' },
  { id: 'user-cashier', email: 'cashier@subtlepos.demo', full_name: 'Tapiwa Dube', role: 'cashier', primary_location_id: 'loc-shop' },
];

const PRODUCT_SEED = [
  { sku: 'SA-001', name: 'Leather Wallet', retail: 1800, wholesale: 1200, cost: 900, qty: { 'loc-shop': 42, 'loc-wholesale': 120 } },
  { sku: 'SA-002', name: 'Aviator Sunglasses', retail: 2200, wholesale: 1500, cost: 1100, qty: { 'loc-shop': 28, 'loc-wholesale': 90 } },
  { sku: 'SA-003', name: 'Beaded Bracelet', retail: 800, wholesale: 500, cost: 350, qty: { 'loc-shop': 65, 'loc-wholesale': 200 } },
  { sku: 'SA-004', name: 'Phone Case — iPhone 14', retail: 1500, wholesale: 950, cost: 700, qty: { 'loc-shop': 37, 'loc-wholesale': 110 } },
  { sku: 'SA-005', name: 'Canvas Tote Bag', retail: 2500, wholesale: 1700, cost: 1250, qty: { 'loc-shop': 20, 'loc-wholesale': 65 } },
  { sku: 'SA-006', name: 'Stainless Steel Watch', retail: 4500, wholesale: 3200, cost: 2400, qty: { 'loc-shop': 15, 'loc-wholesale': 40 } },
  { sku: 'SA-007', name: 'Hoop Earrings', retail: 1000, wholesale: 650, cost: 450, qty: { 'loc-shop': 50, 'loc-wholesale': 150 } },
  { sku: 'SA-008', name: 'Leather Belt', retail: 1600, wholesale: 1050, cost: 800, qty: { 'loc-shop': 33, 'loc-wholesale': 95 } },
  { sku: 'SA-009', name: 'Baseball Cap', retail: 1200, wholesale: 800, cost: 550, qty: { 'loc-shop': 44, 'loc-wholesale': 130 } },
  { sku: 'SA-010', name: 'Silk Scarf', retail: 1900, wholesale: 1300, cost: 950, qty: { 'loc-shop': 18, 'loc-wholesale': 55 } },
];

function buildSeed() {
  const products = [];
  const prices = [];
  const balances = [];

  PRODUCT_SEED.forEach((p, i) => {
    const id = `prod-${i + 1}`;
    products.push({ id, sku: p.sku, barcode: null, name: p.name, base_currency: 'USD', min_wholesale_qty: 6, is_active: true });
    prices.push({ product_id: id, price_type: 'retail', unit_price_cents: p.retail, currency: 'USD', effective_date: '2026-01-01' });
    prices.push({ product_id: id, price_type: 'wholesale', unit_price_cents: p.wholesale, currency: 'USD', effective_date: '2026-01-01' });
    for (const locId of Object.keys(p.qty)) {
      balances.push({
        id: `bal-${id}-${locId}`,
        product_id: id,
        location_id: locId,
        quantity_available: p.qty[locId],
        average_unit_cost_cents: p.cost,
        currency: 'USD',
        needs_review: false,
        updated_at: new Date().toISOString(),
      });
    }
  });

  return { products, prices, balances, sales: [], sale_items: [], sale_payments: [] };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw);
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
    case 'product_prices':
      return state.prices;
    case 'v_inventory_balances':
      return state.balances;
    case 'locations':
      return DEMO_LOCATIONS;
    case 'user_profiles':
      return DEMO_ACCOUNTS;
    case 'sales':
      return state.sales;
    case 'sale_items':
      return state.sale_items;
    case 'sale_payments':
      return state.sale_payments;
    default:
      return [];
  }
}

// Mirrors fn_apply_sale_item_inventory_impact: decrement the selling location's stock the
// moment a sale_items row is written, so Inventory reflects a demo sale immediately.
function applySaleItemStockImpact(row) {
  const sale = state.sales.find((s) => s.id === row.sale_id);
  const balance = state.balances.find((b) => b.product_id === row.product_id && b.location_id === sale?.location_id);
  if (balance) {
    balance.quantity_available -= row.quantity;
    balance.updated_at = new Date().toISOString();
  }
}

function applyWrite(table, rows) {
  const target = tableRows(table);
  for (const row of rows) {
    if (target.find((r) => r.id === row.id)) continue; // upsert + ignoreDuplicates semantics
    target.push(row);
    if (table === 'sale_items') applySaleItemStockImpact(row);
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
  }
  select() {
    return this;
  }
  eq(col, val) {
    this._filters.push((r) => r[col] === val);
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
  // Makes the builder itself awaitable, same shape as the real supabase-js client.
  then(resolve, reject) {
    this._run().then(resolve, reject);
  }
  async _run() {
    if (this._write) return applyWrite(this._table, this._write);

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
  };
}
