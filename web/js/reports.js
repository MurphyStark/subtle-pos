import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';

// STEP 10 of the fashion-retail evolution, plus the reporting requirements from the same
// request: total sales, daily profit, product performance, daily/weekly/monthly sales, a
// detailed monthly report per product, and a Z-report for cash reconciliation.
//
// Manager/owner only -- RLS already restricts sale_items' cost/profit columns to
// is_manager_or_owner() via v_sale_items (a cashier who wanders here would see blank
// profit figures even if the page loaded, but requireAuth keeps them out entirely, same
// pattern as admin.html/purchase-orders.html).
//
// Everything here reads once (the data sets involved are small for a single shop) and
// re-aggregates client-side as the date range/granularity/month/day controls change --
// there's no server-side reporting endpoint, by design, to keep this working the same way
// online or from the offline cache-free path (reports are inherently online-only: they need
// a full, current view of sales history, not a stale local cache).
//
// MULTI-CURRENCY: a single sale is always one currency (see pos.js), but different sales in
// the same range can be in USD/ZWG/ZAR. Summing across currencies would silently produce a
// meaningless number, so every aggregate here is grouped BY CURRENCY and rendered as one
// block per currency present in the range, never blended into a single total.
let profile = null;
let sales = [];
let saleItems = []; // from v_sale_items -- has cost_of_goods_sold_cents/gross_profit_cents
let saleReturns = []; // from v_sale_item_returns
let products = [];
let variants = [];
let granularity = 'daily';

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  const client = getClient();
  const [{ data: s }, { data: si }, { data: sir }, { data: p }, { data: v }] = await Promise.all([
    client.from('sales').select('*'),
    client.from('v_sale_items').select('*'),
    client.from('v_sale_item_returns').select('*'),
    client.from('products').select('id, name'),
    client.from('product_variants').select('id, product_id, size, color, sku'),
  ]);
  sales = s ?? [];
  saleItems = si ?? [];
  saleReturns = sir ?? [];
  products = p ?? [];
  variants = v ?? [];

  wireControls();
  setPreset('month');
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('monthly-detail-month').value = today.slice(0, 7);
  document.getElementById('z-report-date').value = today;
  renderMonthlyDetail();
  renderZReport();
}

function wireControls() {
  document.getElementById('range-from').addEventListener('input', renderAll);
  document.getElementById('range-to').addEventListener('input', renderAll);
  document.getElementById('preset-today').addEventListener('click', () => setPreset('today'));
  document.getElementById('preset-week').addEventListener('click', () => setPreset('week'));
  document.getElementById('preset-month').addEventListener('click', () => setPreset('month'));

  document.getElementById('granularity-daily').addEventListener('click', () => setGranularity('daily'));
  document.getElementById('granularity-weekly').addEventListener('click', () => setGranularity('weekly'));
  document.getElementById('granularity-monthly').addEventListener('click', () => setGranularity('monthly'));

  document.getElementById('monthly-detail-month').addEventListener('input', renderMonthlyDetail);
  document.getElementById('z-report-date').addEventListener('input', renderZReport);
  document.getElementById('export-btn').addEventListener('click', exportToExcel);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function setPreset(preset) {
  const today = new Date();
  let from = new Date(today);
  if (preset === 'week') {
    from.setDate(today.getDate() - today.getDay()); // back to Sunday
  } else if (preset === 'month') {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
  }
  document.getElementById('range-from').value = isoDate(from);
  document.getElementById('range-to').value = isoDate(today);
  ['today', 'week', 'month'].forEach((p) =>
    document.getElementById(`preset-${p}`).classList.toggle('active', p === preset)
  );
  renderAll();
}

function setGranularity(g) {
  granularity = g;
  ['daily', 'weekly', 'monthly'].forEach((g2) =>
    document.getElementById(`granularity-${g2}`).classList.toggle('active', g2 === g)
  );
  renderPeriodTable();
}

function getRange() {
  const fromVal = document.getElementById('range-from').value;
  const toVal = document.getElementById('range-to').value;
  const from = fromVal ? new Date(`${fromVal}T00:00:00`) : null;
  const to = toVal ? new Date(`${toVal}T23:59:59.999`) : null;
  return { from, to };
}

function salesInRange(from, to) {
  return sales.filter((s) => {
    const t = new Date(s.created_at);
    return (!from || t >= from) && (!to || t <= to);
  });
}

function itemsForSales(saleIds) {
  const idSet = new Set(saleIds);
  return saleItems.filter((i) => idSet.has(i.sale_id));
}

function groupByCurrency(salesList) {
  const groups = {};
  for (const s of salesList) {
    (groups[s.currency] ??= []).push(s);
  }
  return groups;
}

function renderAll() {
  renderSummaryCards();
  renderPeriodTable();
  renderProductPerformance();
}

function renderSummaryCards() {
  const { from, to } = getRange();
  const inRange = salesInRange(from, to);
  const container = document.getElementById('summary-cards');

  if (inRange.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); margin-top: 1rem;">No sales in this range.</p>';
    return;
  }

  const byCurrency = groupByCurrency(inRange);
  container.innerHTML = Object.entries(byCurrency)
    .map(([currency, list]) => {
      const items = itemsForSales(list.map((s) => s.id));
      const revenueCents = list.reduce((sum, s) => sum + s.total_cents, 0);
      const profitCents = items.reduce((sum, i) => sum + (i.gross_profit_cents ?? 0), 0);
      const txCount = list.length;
      const avgCents = Math.round(revenueCents / txCount);
      return `
        <div class="card" style="margin-top: 1rem;">
          <h2 style="font-size: 1rem;">${currency}</h2>
          <div class="form-grid">
            <div><div style="color: var(--text-muted); font-size: 0.8rem;">Total sales</div><div style="font-size: 1.3rem; font-weight: 600;">${formatCents(revenueCents, currency)}</div></div>
            <div><div style="color: var(--text-muted); font-size: 0.8rem;">Total profit</div><div style="font-size: 1.3rem; font-weight: 600;">${formatCents(profitCents, currency)}</div></div>
            <div><div style="color: var(--text-muted); font-size: 0.8rem;">Transactions</div><div style="font-size: 1.3rem; font-weight: 600;">${txCount}</div></div>
            <div><div style="color: var(--text-muted); font-size: 0.8rem;">Average sale</div><div style="font-size: 1.3rem; font-weight: 600;">${formatCents(avgCents, currency)}</div></div>
          </div>
        </div>`;
    })
    .join('');
}

function periodLabel(dateObj, gran) {
  if (gran === 'daily') return isoDate(dateObj);
  if (gran === 'monthly') return dateObj.toISOString().slice(0, 7);
  // Weekly: label by the Monday that starts the ISO-ish week (Sunday-start, to match setPreset).
  const monday = new Date(dateObj);
  monday.setDate(dateObj.getDate() - dateObj.getDay());
  return `Week of ${isoDate(monday)}`;
}

function renderPeriodTable() {
  const { from, to } = getRange();
  const inRange = salesInRange(from, to);
  const container = document.getElementById('period-table');

  if (inRange.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">No sales in this range.</p>';
    return;
  }

  const byCurrency = groupByCurrency(inRange);
  container.innerHTML = Object.entries(byCurrency)
    .map(([currency, list]) => {
      const periods = {};
      for (const s of list) {
        const label = periodLabel(new Date(s.created_at), granularity);
        (periods[label] ??= { sales: [], revenue: 0, profit: 0 }).sales.push(s.id);
        periods[label].revenue += s.total_cents;
      }
      for (const label of Object.keys(periods)) {
        const items = itemsForSales(periods[label].sales);
        periods[label].profit = items.reduce((sum, i) => sum + (i.gross_profit_cents ?? 0), 0);
      }
      const rows = Object.entries(periods)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(
          ([label, p]) => `
        <tr>
          <td>${label}</td>
          <td>${p.sales.length}</td>
          <td>${formatCents(p.revenue, currency)}</td>
          <td>${formatCents(p.profit, currency)}</td>
        </tr>`
        )
        .join('');
      return `
        <h3 style="font-size: 0.9rem; margin-top: 1rem;">${currency}</h3>
        <table>
          <thead><tr><th>Period</th><th>Transactions</th><th>Revenue</th><th>Profit</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join('');
}

function renderProductPerformance() {
  const { from, to } = getRange();
  const inRange = salesInRange(from, to);
  const container = document.getElementById('product-performance-table');

  if (inRange.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">No sales in this range.</p>';
    return;
  }

  const variantById = Object.fromEntries(variants.map((v) => [v.id, v]));
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const items = itemsForSales(inRange.map((s) => s.id));
  const saleCurrency = Object.fromEntries(inRange.map((s) => [s.id, s.currency]));

  const byCurrency = {};
  for (const item of items) {
    const currency = saleCurrency[item.sale_id] ?? 'USD';
    const variant = variantById[item.variant_id];
    const productId = variant?.product_id ?? 'unknown';
    const productName = productById[productId]?.name ?? 'Unknown product';
    const bucket = (byCurrency[currency] ??= {});
    const entry = (bucket[productId] ??= { name: productName, quantity: 0, revenue: 0, profit: 0 });
    entry.quantity += item.quantity;
    entry.revenue += item.quantity * item.unit_selling_price_cents;
    entry.profit += item.gross_profit_cents ?? 0;
  }

  container.innerHTML = Object.entries(byCurrency)
    .map(([currency, productsInCurrency]) => {
      const rows = Object.values(productsInCurrency)
        .sort((a, b) => b.revenue - a.revenue)
        .map((p) => {
          const margin = p.revenue > 0 ? ((p.profit / p.revenue) * 100).toFixed(1) : '0.0';
          return `
        <tr>
          <td>${p.name}</td>
          <td>${p.quantity}</td>
          <td>${formatCents(p.revenue, currency)}</td>
          <td>${formatCents(p.profit, currency)}</td>
          <td>${margin}%</td>
        </tr>`;
        })
        .join('');
      return `
        <h3 style="font-size: 0.9rem; margin-top: 1rem;">${currency}</h3>
        <table>
          <thead><tr><th>Product</th><th>Units sold</th><th>Revenue</th><th>Profit</th><th>Margin</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join('');
}

function renderMonthlyDetail() {
  const monthVal = document.getElementById('monthly-detail-month').value;
  const container = document.getElementById('monthly-detail-table');
  if (!monthVal) {
    container.innerHTML = '';
    return;
  }
  const from = new Date(`${monthVal}-01T00:00:00`);
  const to = new Date(from.getFullYear(), from.getMonth() + 1, 0, 23, 59, 59, 999);
  const inRange = salesInRange(from, to);

  if (inRange.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">No sales in this month.</p>';
    return;
  }

  const variantById = Object.fromEntries(variants.map((v) => [v.id, v]));
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const items = itemsForSales(inRange.map((s) => s.id));
  const saleCurrency = Object.fromEntries(inRange.map((s) => [s.id, s.currency]));

  // Every product (not just ones with sales) so a manager can see zero-activity products too.
  const byCurrency = {};
  for (const item of items) {
    const currency = saleCurrency[item.sale_id] ?? 'USD';
    const variant = variantById[item.variant_id];
    const productId = variant?.product_id ?? 'unknown';
    const productName = productById[productId]?.name ?? 'Unknown product';
    const bucket = (byCurrency[currency] ??= {});
    const entry = (bucket[productId] ??= { name: productName, quantity: 0, revenue: 0, cost: 0, profit: 0 });
    entry.quantity += item.quantity;
    entry.revenue += item.quantity * item.unit_selling_price_cents;
    entry.cost += item.cost_of_goods_sold_cents ?? 0;
    entry.profit += item.gross_profit_cents ?? 0;
  }

  container.innerHTML =
    Object.entries(byCurrency)
      .map(([currency, productsInCurrency]) => {
        const rows = Object.values(productsInCurrency)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (p) => `
        <tr>
          <td>${p.name}</td>
          <td>${p.quantity}</td>
          <td>${formatCents(p.revenue, currency)}</td>
          <td>${formatCents(p.cost, currency)}</td>
          <td>${formatCents(p.profit, currency)}</td>
        </tr>`
          )
          .join('');
        return `
        <h3 style="font-size: 0.9rem;">${currency}</h3>
        <table>
          <thead><tr><th>Product</th><th>Units sold</th><th>Revenue</th><th>Cost</th><th>Profit</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      })
      .join('') || '<p style="color: var(--text-muted);">No sales in this month.</p>';
}

// A Z-report reconciles cash drawer/payment totals for one trading day. Refunds paid out
// THAT day are subtracted per method, since that's cash/card/etc. that actually left the
// till today regardless of which day the original sale happened.
function renderZReport() {
  const dateVal = document.getElementById('z-report-date').value;
  const container = document.getElementById('z-report-table');
  if (!dateVal) {
    container.innerHTML = '';
    return;
  }
  const from = new Date(`${dateVal}T00:00:00`);
  const to = new Date(`${dateVal}T23:59:59.999`);
  const daySales = salesInRange(from, to);
  const dayReturns = saleReturns.filter((r) => {
    const t = new Date(r.created_at);
    return t >= from && t <= to;
  });

  if (daySales.length === 0 && dayReturns.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">No sales or refunds on this date.</p>';
    return;
  }

  // sale_payments isn't cached client-side elsewhere -- fetched fresh here since the
  // Z-report is the only place that needs a per-method breakdown.
  container.innerHTML = '<p style="color: var(--text-muted);">Loading…</p>';
  renderZReportAsync(daySales, dayReturns, container);
}

async function renderZReportAsync(daySales, dayReturns, container) {
  const client = getClient();
  const { data: payments } = await client.from('sale_payments').select('*').in('sale_id', daySales.map((s) => s.id));
  const saleCurrency = Object.fromEntries(daySales.map((s) => [s.id, s.currency]));

  const byCurrency = {};
  for (const p of payments ?? []) {
    const currency = saleCurrency[p.sale_id] ?? p.currency;
    const bucket = (byCurrency[currency] ??= {});
    bucket[p.method] = (bucket[p.method] ?? 0) + p.amount_cents;
  }
  for (const r of dayReturns) {
    // Refund method isn't necessarily the same currency-keyed bucket as the original sale
    // if currencies were ever mixed, but a sale (and therefore its refund) is single-currency
    // by construction (see pos.js) -- refund_amount_cents was computed in that same currency.
    const currency = daySales.find((s) => s.id === r.sale_id)?.currency ?? Object.keys(byCurrency)[0] ?? 'USD';
    const bucket = (byCurrency[currency] ??= {});
    bucket[`refund_${r.refund_method}`] = (bucket[`refund_${r.refund_method}`] ?? 0) - r.refund_amount_cents;
  }

  container.innerHTML =
    Object.entries(byCurrency)
      .map(([currency, methods]) => {
        const rows = Object.entries(methods)
          .map(([method, cents]) => {
            const label = method.startsWith('refund_') ? `Refunds — ${method.slice(7)}` : method;
            return `<tr><td>${label}</td><td>${formatCents(cents, currency)}</td></tr>`;
          })
          .join('');
        const netTotal = Object.values(methods).reduce((sum, c) => sum + c, 0);
        return `
        <h3 style="font-size: 0.9rem;">${currency}</h3>
        <table>
          <thead><tr><th>Method</th><th>Net amount</th></tr></thead>
          <tbody>${rows}<tr style="font-weight: 600;"><td>Total</td><td>${formatCents(netTotal, currency)}</td></tr></tbody>
        </table>`;
      })
      .join('') || '<p style="color: var(--text-muted);">No payments recorded on this date.</p>';
}

// Requirement: "Integrate the system with an Excel spreadsheet for data export, backup,
// reporting, and analysis." Builds a real multi-sheet .xlsx (via SheetJS, loaded from the
// CDN allowlist) covering the raw tables a manager would need for backup/offline analysis,
// not just the on-screen aggregates -- so this button works the same regardless of which
// report section is currently showing.
async function exportToExcel() {
  const client = getClient();
  const [{ data: allSales }, { data: allItems }, { data: allProducts }, { data: allVariants }, { data: allCustomers }] =
    await Promise.all([
      client.from('sales').select('*'),
      client.from('v_sale_items').select('*'),
      client.from('products').select('*'),
      client.from('product_variants').select('*'),
      client.from('customers').select('*'),
    ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allSales ?? []), 'Sales');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allItems ?? []), 'Sale Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allProducts ?? []), 'Products');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allVariants ?? []), 'Variants');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allCustomers ?? []), 'Customers');

  XLSX.writeFile(wb, `subtle-pos-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

init();
