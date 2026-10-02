import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { logActivity } from './activity.js';
import { icon } from './icons.js';
import { statCard, stockStatus, stockPill, thumb, pill, DEFAULT_LOW_STOCK } from './ui.js';
import { loadCatalog, variantLabel, stockCountReference, formatDateTime, receiveStock, recordStockCount } from './catalog.js';

// One variant (variant.html?id=<product_variants.id>): its stock at each location the viewer
// can see, 30 days of movement, every recorded stock transaction, and quick actions.
//
// There is no single "stock movements" table -- the history is assembled from the records
// that actually change stock: sales (out), returns (in), stock receipts (in), completed
// stock counts (+/- the variance), and received transfers (out of one location, into
// another). RLS decides what the viewer sees, so a non-admin never sees Warehouse moves.
//
// Quick actions go through the same paths as the rest of the app: "Add stock" is a stock
// receipt at the product's cost; "Remove stock" and "Set stock level" are one-line stock
// counts (with the reason as the note), so every change stays auditable.
let profile = null;
let catalog = null;
let variant = null;
let product = null;
let transactions = [];
let showAllTx = false;

async function init() {
  registerServiceWorker();
  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner', 'admin']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  document.querySelectorAll('.action-tile').forEach((tile) => {
    const name = { add: 'plus', remove: 'minus', set: 'pencil', count: 'clipboard' }[tile.dataset.action];
    tile.insertAdjacentHTML('afterbegin', icon(name, { size: 26 }));
    if (tile.tagName === 'BUTTON') tile.addEventListener('click', () => openAction(tile.dataset.action));
  });
  document.getElementById('toggle-all-tx').addEventListener('click', () => {
    showAllTx = !showAllTx;
    renderTransactions();
  });

  await load();
}

async function load() {
  const client = getClient();
  catalog = await loadCatalog(client);
  const id = new URLSearchParams(location.search).get('id');
  variant = catalog.variantById[id];
  product = catalog.productById[variant?.product_id];
  if (!variant || !product) {
    document.getElementById('page-error').textContent = 'That variant could not be found.';
    document.getElementById('variant-page').hidden = true;
    return;
  }
  document.title = `Subtle POS — ${product.name} ${variantLabel(variant)}`;
  document.getElementById('edit-product-link').href = `product.html?id=${product.id}`;
  document.getElementById('manage-variants').href = `product.html?id=${product.id}`;
  document.querySelector('[data-action="count"]').href = `stock-take.html?variant=${variant.id}`;

  transactions = await loadTransactions(client);
  render();
}

async function loadTransactions(client) {
  const [
    { data: sales },
    { data: saleItems },
    { data: returns },
    { data: receipts },
    { data: receiptItems },
    { data: counts },
    { data: countItems },
    { data: transfers },
    { data: transferItems },
    { data: people },
  ] = await Promise.all([
    client.from('sales').select('id, location_id, cashier_id, created_at, voided_at'),
    client.from('v_sale_items').select('id, sale_id, variant_id, quantity').eq('variant_id', variant.id),
    client.from('v_sale_item_returns').select('*'),
    client.from('stock_receipts').select('*'),
    client.from('stock_receipt_items').select('*').eq('variant_id', variant.id),
    client.from('stock_counts').select('*'),
    client.from('stock_count_items').select('*').eq('variant_id', variant.id),
    client.from('inventory_transfers').select('*'),
    client.from('inventory_transfer_items').select('*').eq('variant_id', variant.id),
    client.from('user_profiles').select('id, full_name'),
  ]);
  const name = Object.fromEntries((people ?? []).map((p) => [p.id, p.full_name]));
  const byId = (list) => Object.fromEntries((list ?? []).map((x) => [x.id, x]));
  const saleById = byId(sales);
  const receiptById = byId(receipts);
  const countById = byId(counts);
  const transferById = byId(transfers);
  const saleItemById = byId(saleItems);
  const tx = [];

  for (const item of saleItems ?? []) {
    const sale = saleById[item.sale_id];
    if (!sale || sale.voided_at) continue;
    tx.push({ at: sale.created_at, type: 'Sale', tone: 'danger', ref: `#${sale.id.slice(0, 8).toUpperCase()}`, qty: -item.quantity, locationId: sale.location_id, user: name[sale.cashier_id], notes: 'POS sale' });
  }
  for (const r of returns ?? []) {
    if (!saleItemById[r.sale_item_id]) continue;
    tx.push({ at: r.created_at, type: 'Return', tone: 'info', ref: `RET-${r.id.slice(0, 6).toUpperCase()}`, qty: r.quantity_returned, locationId: r.restock_location_id, user: name[r.processed_by], notes: r.reason ?? '' });
  }
  for (const item of receiptItems ?? []) {
    const receipt = receiptById[item.stock_receipt_id];
    if (!receipt) continue;
    tx.push({
      at: receipt.received_at ?? receipt.created_at,
      type: receipt.purchase_order_id ? 'Purchase' : 'Stock added',
      tone: 'success',
      ref: receipt.purchase_order_id ? `PO-${receipt.purchase_order_id.slice(0, 6).toUpperCase()}` : `GRN-${receipt.id.slice(0, 6).toUpperCase()}`,
      qty: item.quantity,
      locationId: receipt.location_id,
      user: name[receipt.created_by],
      notes: receipt.notes ?? (receipt.purchase_order_id ? 'Stock received' : ''),
    });
  }
  for (const item of countItems ?? []) {
    const count = countById[item.stock_count_id];
    const delta = item.counted_quantity - item.system_quantity_at_count;
    if (!count || count.status !== 'completed' || delta === 0) continue;
    tx.push({ at: count.completed_at ?? count.created_at, type: 'Stock count', tone: 'warning', ref: stockCountReference(count), href: `stock-take-report.html?id=${count.id}`, qty: delta, locationId: count.location_id, user: name[count.counted_by], notes: item.notes ?? '' });
  }
  for (const item of transferItems ?? []) {
    const t = transferById[item.inventory_transfer_id];
    const moved = item.quantity_received ?? 0;
    if (!t || moved <= 0 || !['received', 'partially_received'].includes(t.status)) continue;
    const ref = `TRF-${t.id.slice(0, 6).toUpperCase()}`;
    tx.push({ at: t.created_at, type: 'Transfer out', tone: 'neutral', ref, qty: -moved, locationId: t.from_location_id, user: name[t.approved_by ?? t.requested_by], notes: '' });
    tx.push({ at: t.created_at, type: 'Transfer in', tone: 'neutral', ref, qty: moved, locationId: t.to_location_id, user: name[t.approved_by ?? t.requested_by], notes: '' });
  }
  // Only movements at locations this viewer can see.
  const visible = new Set(catalog.locations.map((l) => l.id));
  return tx.filter((t) => visible.has(t.locationId)).sort((a, b) => (a.at < b.at ? 1 : -1));
}

function render() {
  const total = catalog.qty(variant.id);
  const status = stockStatus(total, variant.reorder_threshold);
  const balances = catalog.balancesByVariant[variant.id] ?? [];
  const costed = balances.filter((b) => b.average_unit_cost_cents != null && b.quantity_available > 0);
  const units = costed.reduce((s, b) => s + b.quantity_available, 0);
  const avgCost = units ? Math.round(costed.reduce((s, b) => s + b.quantity_available * b.average_unit_cost_cents, 0) / units) : (product.cost?.unit_cost_cents ?? balances[0]?.average_unit_cost_cents ?? null);
  const currency = product.retail?.currency ?? 'USD';

  document.getElementById('variant-hero').innerHTML = `
    ${thumb(product.image_url, product.name, 'lg')}
    <div>
      <h2 class="hero-title">${product.name}</h2>
      <p class="hero-sub">${variantLabel(variant) || 'Standard'}</p>
      ${stockPill(status)}
      <dl class="attr-grid">
        <div><dt>SKU</dt><dd>${variant.sku}</dd></div>
        <div><dt>Category</dt><dd>${product.categoryName || '—'}</dd></div>
        <div><dt>Brand</dt><dd>${product.brand || '—'}</dd></div>
        <div><dt>Size</dt><dd>${variant.size || '—'}</dd></div>
        <div><dt>Colour</dt><dd>${variant.color || '—'}</dd></div>
        <div><dt>Barcode</dt><dd>${variant.barcode || '—'}</dd></div>
      </dl>
    </div>`;

  document.getElementById('variant-stats').innerHTML = [
    statCard({ label: 'Current stock', value: total, sub: 'units', iconName: 'box', tone: 'blue' }),
    product.costSet
      ? statCard({ label: 'Average unit cost', value: avgCost != null ? formatCents(avgCost, currency) : '—', iconName: 'trend', tone: 'green' })
      : statCard({ label: 'Average unit cost', value: 'Not set', sub: 'Enter it on the product', iconName: 'trend', tone: 'green' }),
    statCard({ label: 'Retail price', value: product.retail ? formatCents(product.retail.unit_price_cents, currency) : '—', iconName: 'tag', tone: 'amber' }),
    statCard({ label: 'Low stock level', value: variant.reorder_threshold ?? DEFAULT_LOW_STOCK, sub: 'units', iconName: 'alert', tone: 'purple' }),
  ].join('');

  document.getElementById('location-body').innerHTML =
    catalog.locations
      .map((l) => {
        const q = catalog.qty(variant.id, l.id);
        return `<tr><td>${l.name}</td><td class="num">${q}</td><td>${stockPill(stockStatus(q, variant.reorder_threshold))}</td></tr>`;
      })
      .join('') + (catalog.locations.length > 1 ? `<tr class="total-row"><td>Total</td><td class="num">${total}</td><td></td></tr>` : '');

  document.getElementById('siblings-body').innerHTML = product.variants
    .filter((v) => v.is_active !== false)
    .map((v) => {
      const q = catalog.qty(v.id);
      return `<tr class="${v.id === variant.id ? 'is-current' : ''}"><td><a href="variant.html?id=${v.id}">${variantLabel(v) || 'Standard'}</a><span class="sub muted" style="display: block; font-size: 12.5px;">${v.sku}</span></td><td class="num">${q}</td><td>${stockPill(stockStatus(q, v.reorder_threshold))}</td></tr>`;
    })
    .join('');

  renderChart();
  renderTransactions();
}

function renderChart() {
  const days = 30;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { date: d, in: 0, out: 0 };
  });
  for (const t of transactions) {
    const i = Math.floor((new Date(t.at) - start) / 86400000);
    if (i < 0 || i >= days) continue;
    if (t.type.startsWith('Transfer') && catalog.locations.length > 1) continue; // moves between visible locations net to zero
    if (t.qty > 0) buckets[i].in += t.qty;
    else buckets[i].out += -t.qty;
  }
  const max = Math.max(4, ...buckets.map((b) => Math.max(b.in, b.out)));
  const W = 640;
  const H = 180;
  const padL = 28;
  const padB = 24;
  const slot = (W - padL) / days;
  const bw = Math.max(3, slot / 2 - 2);
  const y = (v) => H - padB - (v / max) * (H - padB - 8);
  const ticks = [0, Math.round(max / 2), max];
  const bars = buckets
    .map((b, i) => {
      const x = padL + i * slot + 2;
      const label = b.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return `${b.in ? `<rect x="${x}" y="${y(b.in)}" width="${bw}" height="${H - padB - y(b.in)}" rx="1.5" fill="#2f9e5b"><title>${label}: +${b.in} in</title></rect>` : ''}
        ${b.out ? `<rect x="${x + bw + 1}" y="${y(b.out)}" width="${bw}" height="${H - padB - y(b.out)}" rx="1.5" fill="#e5484d"><title>${label}: -${b.out} out</title></rect>` : ''}
        ${i % 5 === 0 || i === days - 1 ? `<text x="${i === days - 1 ? W - 2 : x + bw}" y="${H - 6}" text-anchor="${i === days - 1 ? 'end' : 'middle'}" class="axis">${label}</text>` : ''}`;
    })
    .join('');
  const any = buckets.some((b) => b.in || b.out);
  document.getElementById('movement-chart').innerHTML = `
    <svg class="bar-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Units in and out per day over the last 30 days">
      ${ticks.map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid" /><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" class="axis">${t}</text>`).join('')}
      ${bars}
    </svg>
    ${any ? '' : '<p class="muted" style="text-align: center; margin: -90px 0 70px;">No stock movement in the last 30 days.</p>'}`;
}

function renderTransactions() {
  const multi = catalog.locations.length > 1;
  const locationName = Object.fromEntries(catalog.locations.map((l) => [l.id, l.name]));
  document.getElementById('tx-head').innerHTML = `<tr><th>Date &amp; time</th><th>Type</th><th>Reference</th>${multi ? '<th>Location</th>' : ''}<th class="num">Quantity</th><th>User</th><th>Notes</th></tr>`;
  const shown = showAllTx ? transactions : transactions.slice(0, 6);
  const toggle = document.getElementById('toggle-all-tx');
  toggle.hidden = transactions.length <= 6;
  toggle.textContent = showAllTx ? 'Show fewer' : `View all (${transactions.length})`;
  document.getElementById('tx-body').innerHTML =
    shown
      .map(
        (t) => `
      <tr>
        <td class="nowrap">${formatDateTime(t.at)}</td>
        <td>${pill(t.tone, t.type)}</td>
        <td class="nowrap">${t.href ? `<a href="${t.href}">${t.ref}</a>` : t.ref}</td>
        ${multi ? `<td class="muted">${locationName[t.locationId] ?? '—'}</td>` : ''}
        <td class="num ${t.qty < 0 ? 'text-danger' : 'text-success'}"><strong>${t.qty > 0 ? '+' : ''}${t.qty}</strong></td>
        <td>${t.user ?? '—'}</td>
        <td class="muted">${t.notes || '—'}</td>
      </tr>`
      )
      .join('') || `<tr><td colspan="${multi ? 7 : 6}" class="muted" style="text-align: center; padding: 28px;">No stock transactions recorded for this variant yet.</td></tr>`;
}

// ---------- quick actions ----------
function openAction(kind) {
  const panel = document.getElementById('action-panel');
  document.querySelectorAll('.action-tile').forEach((t) => t.classList.toggle('active', t.dataset.action === kind));
  const locationSelect = `<label>Location<select data-f="location">${catalog.locations.map((l) => `<option value="${l.id}" ${l.id === profile.primary_location_id ? 'selected' : ''}>${l.name}</option>`).join('')}</select></label>`;
  const title = { add: 'Add stock', remove: 'Remove stock', set: 'Set stock level' }[kind];
  const fields = {
    add: `${locationSelect}
      <label>Quantity to add<input type="number" data-f="qty" min="1" step="1" value="1" /></label>
      <label>Unit cost<input type="number" data-f="cost" min="0" step="0.01" value="${product.costSet ? (product.cost.unit_cost_cents / 100).toFixed(2) : ''}" placeholder="${product.costSet ? '' : 'Cost not set yet'}" /></label>
      <label>Note<input type="text" data-f="note" placeholder="e.g. New delivery" /></label>`,
    remove: `${locationSelect}
      <label>Quantity to remove<input type="number" data-f="qty" min="1" step="1" value="1" /></label>
      <label>Reason<select data-f="reason"><option>Damaged</option><option>Lost or stolen</option><option>Returned to supplier</option><option>Used as display / sample</option><option>Other</option></select></label>
      <label>Note<input type="text" data-f="note" placeholder="optional" /></label>`,
    set: `${locationSelect}
      <label>New quantity<input type="number" data-f="qty" min="0" step="1" /></label>
      <label>Reason<input type="text" data-f="note" placeholder="e.g. Recount after delivery" /></label>`,
  }[kind];
  panel.innerHTML = `
    <div class="inline-form" style="margin-top: 14px;">
      <h3 class="side-title" style="margin-bottom: 10px;">${title}</h3>
      <div class="admin-form">${fields}</div>
      <p class="muted" id="action-hint" style="font-size: 13px; margin: 8px 0 0;"></p>
      <p class="error" id="action-error"></p>
      <div class="inline-form-actions">
        <button type="button" class="ghost" id="action-cancel">Cancel</button>
        <button type="button" class="primary" id="action-apply">${title}</button>
      </div>
    </div>`;
  const get = (k) => panel.querySelector(`[data-f="${k}"]`);
  const hint = () => {
    const current = catalog.qty(variant.id, get('location').value);
    const n = Math.floor(Number(get('qty').value));
    const next = kind === 'add' ? current + (n || 0) : kind === 'remove' ? Math.max(0, current - (n || 0)) : n;
    document.getElementById('action-hint').textContent = Number.isFinite(next) ? `Currently ${current} here → ${next} after this change.` : `Currently ${current} here.`;
  };
  get('location').addEventListener('change', hint);
  get('qty').addEventListener('input', hint);
  if (kind === 'set') get('qty').value = catalog.qty(variant.id, get('location').value);
  hint();
  get('qty').focus();
  document.getElementById('action-cancel').addEventListener('click', closeAction);
  document.getElementById('action-apply').addEventListener('click', () => applyAction(kind, get));
}

function closeAction() {
  document.getElementById('action-panel').innerHTML = '';
  document.querySelectorAll('.action-tile').forEach((t) => t.classList.remove('active'));
}

async function applyAction(kind, get) {
  const errorEl = document.getElementById('action-error');
  errorEl.textContent = '';
  const client = getClient();
  const locationId = get('location').value;
  const qty = Math.floor(Number(get('qty').value));
  const current = catalog.qty(variant.id, locationId);
  const note = get('note').value.trim();
  const btn = document.getElementById('action-apply');

  if (!Number.isFinite(qty) || qty < (kind === 'set' ? 0 : 1)) return (errorEl.textContent = 'Enter a valid quantity.');
  if (kind === 'remove' && qty > current) return (errorEl.textContent = `Only ${current} in stock at this location.`);

  btn.disabled = true;
  try {
    let summary;
    if (kind === 'add') {
      const costInput = get('cost').value;
      if (costInput === '') throw new Error('Enter the unit cost so the average cost stays right.');
      await receiveStock(client, { variantId: variant.id, locationId, quantity: qty, unitCostCents: toCents(costInput), currency: product.cost?.currency ?? product.retail?.currency ?? 'USD', createdBy: profile.id, notes: note || null });
      summary = `added ${qty}`;
    } else {
      const target = kind === 'remove' ? current - qty : qty;
      const reason = kind === 'remove' ? [get('reason').value, note].filter(Boolean).join(' — ') : note || 'Stock level set';
      await recordStockCount(client, { locationId, countedBy: profile.id, items: [{ variant_id: variant.id, counted_quantity: target, system_quantity_at_count: current, notes: reason }] });
      summary = kind === 'remove' ? `removed ${qty} (${reason})` : `set stock to ${target}`;
    }
    await logActivity(profile, 'stock_change', `${profile.full_name} ${summary} for ${variant.sku}`, { variant_id: variant.id, location_id: locationId });
    closeAction();
    await load();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
    btn.disabled = false;
  }
}

init();
