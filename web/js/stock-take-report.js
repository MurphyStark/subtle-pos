import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { icon } from './icons.js';
import { statCard, pill, thumb, breakdownList, donut } from './ui.js';
import { loadCatalog, variantLabel, stockCountReference, formatDateTime } from './catalog.js';

// One stock take in full (stock-take-report.html?id=<stock_counts.id>): who counted what,
// where, every line's system vs counted quantity, the adjustment it made, and notes. Doubles
// as the printable report -- "Print report" prints just this page (see @media print,
// body.printable-page), and "Export" downloads the lines as CSV for Excel.
let lines = [];
let count = null;
const view = { term: '', category: '', variance: '' };

const COLORS = { shortage: '#e5484d', overage: '#2f9e5b', match: '#c9c9c4' };

async function init() {
  registerServiceWorker();
  const auth = await requireAuth();
  if (!auth) return;
  renderNav(auth.profile);
  document.body.classList.add('printable-page');

  const id = new URLSearchParams(location.search).get('id');
  const client = getClient();
  const { data: found } = await client.from('stock_counts').select('*').eq('id', id ?? '');
  count = found?.[0];
  if (!count) {
    document.getElementById('report-error').textContent = 'That stock take could not be found (or belongs to a location you cannot see).';
    document.getElementById('report-body').innerHTML = '';
    return;
  }

  const [catalog, { data: items }, { data: people }] = await Promise.all([
    loadCatalog(client),
    client.from('stock_count_items').select('*').eq('stock_count_id', count.id),
    client.from('user_profiles').select('id, full_name'),
  ]);
  const personName = Object.fromEntries((people ?? []).map((p) => [p.id, p.full_name]));
  const locationName = Object.fromEntries(catalog.locations.map((l) => [l.id, l.name]));

  lines = (items ?? [])
    .map((i) => {
      const variant = catalog.variantById[i.variant_id];
      const product = catalog.productById[variant?.product_id];
      const variance = i.counted_quantity - i.system_quantity_at_count;
      return { ...i, variant, product, variance, kind: variance < 0 ? 'shortage' : variance > 0 ? 'overage' : 'match' };
    })
    .sort((a, b) => (a.product?.name ?? '').localeCompare(b.product?.name ?? '') || (a.variant?.sku ?? '').localeCompare(b.variant?.sku ?? ''));

  const reference = stockCountReference(count);
  document.title = `Subtle POS — ${reference}`;
  document.getElementById('crumb-ref').textContent = reference;

  const shortages = lines.filter((l) => l.kind === 'shortage');
  const overages = lines.filter((l) => l.kind === 'overage');
  const matched = lines.filter((l) => l.kind === 'match');
  const counted = lines.reduce((s, l) => s + l.counted_quantity, 0);
  const system = lines.reduce((s, l) => s + l.system_quantity_at_count, 0);

  document.getElementById('report-stats').innerHTML = [
    statCard({ label: 'Items counted', value: lines.length, iconName: 'box', tone: 'blue' }),
    statCard({ label: 'Units counted', value: counted, sub: `of ${system} system units`, iconName: 'check', tone: 'green' }),
    statCard({ label: 'Items with variances', value: shortages.length + overages.length, sub: `${shortages.length} shortage${shortages.length === 1 ? '' : 's'}, ${overages.length} overage${overages.length === 1 ? '' : 's'}`, iconName: 'alert', tone: 'red' }),
    statCard({ label: 'Items matched', value: matched.length, sub: 'no variance', iconName: 'clipboard', tone: 'purple' }),
  ].join('');

  document.getElementById('report-info').innerHTML = `
    <dl class="meta-row">
      <div><dt>Reference</dt><dd>${reference}</dd></div>
      <div><dt>Date &amp; time</dt><dd>${formatDateTime(count.completed_at ?? count.created_at)}</dd></div>
      <div><dt>Counted by</dt><dd>${personName[count.counted_by] ?? '—'}</dd></div>
      <div><dt>Location</dt><dd>${locationName[count.location_id] ?? '—'}</dd></div>
      <div><dt>Status</dt><dd>${count.status === 'completed' ? pill('success', 'Completed') : pill('warning', 'In progress')}</dd></div>
    </dl>
    <div class="info-actions no-print">
      <button type="button" class="ghost" id="print-btn">${icon('printer', { size: 18 })} Print report</button>
      <button type="button" class="primary" id="export-btn">${icon('download', { size: 18 })} Export to Excel</button>
    </div>`;
  document.getElementById('print-btn').addEventListener('click', () => window.print());
  document.getElementById('export-btn').addEventListener('click', () => exportCsv(reference));

  const categories = [...new Set(lines.map((l) => l.product?.categoryName).filter(Boolean))].sort();
  document.getElementById('report-category').innerHTML += categories.map((c) => `<option value="${c}">${c}</option>`).join('');
  const search = document.getElementById('report-search');
  search.addEventListener('input', () => {
    view.term = search.value.trim().toLowerCase();
    renderRows();
  });
  document.getElementById('report-category').addEventListener('change', (e) => {
    view.category = e.target.value;
    renderRows();
  });
  document.getElementById('report-variance').addEventListener('change', (e) => {
    view.variance = e.target.value;
    renderRows();
  });
  renderRows();

  const pct = (n) => (lines.length ? `${((n / lines.length) * 100).toFixed(1)}%` : '0%');
  const byCategory = {};
  for (const l of lines) {
    const key = l.product?.categoryName || 'Uncategorised';
    const entry = (byCategory[key] ??= { counted: 0, withVariance: 0, image: l.product?.image_url });
    entry.counted += 1;
    if (l.variance !== 0) entry.withVariance += 1;
  }
  document.getElementById('report-side').innerHTML = `
    <section class="card">
      <h3 class="side-title">Variance summary</h3>
      <div class="donut-row">
        ${donut(
          [
            { value: shortages.length, color: COLORS.shortage, label: 'Shortages' },
            { value: overages.length, color: COLORS.overage, label: 'Overages' },
            { value: matched.length, color: COLORS.match, label: 'No variance' },
          ],
          { centerValue: lines.length, centerLabel: 'Items' }
        )}
        <ul class="legend">
          <li><span class="swatch" style="background: ${COLORS.shortage}"></span>Shortages<strong>${shortages.length}</strong><small>${pct(shortages.length)}</small></li>
          <li><span class="swatch" style="background: ${COLORS.overage}"></span>Overages<strong>${overages.length}</strong><small>${pct(overages.length)}</small></li>
          <li><span class="swatch" style="background: ${COLORS.match}"></span>No variance<strong>${matched.length}</strong><small>${pct(matched.length)}</small></li>
        </ul>
      </div>
      ${breakdownList(shortages, overages, matched.length)}
    </section>
    <section class="card">
      <h3 class="side-title">Category breakdown</h3>
      <table class="compact-table">
        <thead><tr><th>Category</th><th class="num">Counted</th><th class="num">Variances</th></tr></thead>
        <tbody>
          ${Object.entries(byCategory)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, e]) => `<tr><td><div class="cell-product">${thumb(e.image, '', 'sm')}<span>${name}</span></div></td><td class="num">${e.counted}</td><td class="num ${e.withVariance ? 'text-danger' : ''}">${e.withVariance}</td></tr>`)
            .join('')}
        </tbody>
      </table>
    </section>
    <section class="callout no-print">${icon('alert', { size: 18 })}<span><strong>Next steps</strong><br />Stock levels were updated when this count was completed. Carry on selling, or start a new stock take.</span></section>`;
}

function varianceChip(v) {
  if (v === 0) return '<span class="variance variance-zero">0</span>';
  return `<span class="variance ${v > 0 ? 'variance-over' : 'variance-under'}">${v > 0 ? '+' : ''}${v}</span>`;
}

function renderRows() {
  const visible = lines.filter((l) => {
    if (view.category && l.product?.categoryName !== view.category) return false;
    if (view.variance && l.kind !== view.variance) return false;
    if (!view.term) return true;
    return (l.product?.name ?? '').toLowerCase().includes(view.term) || (l.variant?.sku ?? '').toLowerCase().includes(view.term) || (l.variant?.barcode ?? '') === view.term;
  });
  const status = { shortage: pill('danger', 'Shortage'), overage: pill('warning', 'Overage'), match: pill('success', 'Match') };
  document.getElementById('report-body').innerHTML =
    visible
      .map(
        (l, i) => `
      <tr>
        <td class="muted">${i + 1}</td>
        <td><div class="cell-product">${thumb(l.product?.image_url, '', 'sm')}<span><span class="name">${l.product?.name ?? 'Removed product'}</span><span class="sub">${variantLabel(l.variant) || '—'}</span></span></div></td>
        <td class="muted nowrap">${l.variant?.sku ?? '—'}</td>
        <td class="muted">${l.product?.categoryName || '—'}</td>
        <td class="num">${l.system_quantity_at_count}</td>
        <td class="num">${l.counted_quantity}</td>
        <td>${varianceChip(l.variance)}</td>
        <td class="nowrap">${l.variance === 0 ? '<span class="muted">—</span>' : `<span class="${l.variance < 0 ? 'text-danger' : 'text-success'}">${l.variance < 0 ? '↓' : '↑'} ${l.variance > 0 ? '+' : ''}${l.variance}</span>`}</td>
        <td class="num"><strong>${l.counted_quantity}</strong></td>
        <td>${status[l.kind]}</td>
        <td class="muted">${l.notes || '—'}</td>
      </tr>`
      )
      .join('') || '<tr><td colspan="11" class="muted" style="text-align: center; padding: 28px;">No items match these filters.</td></tr>';
}

function exportCsv(reference) {
  const header = ['#', 'Product', 'Variant', 'SKU', 'Category', 'System stock', 'Counted stock', 'Variance', 'New stock', 'Status', 'Notes'];
  const label = { shortage: 'Shortage', overage: 'Overage', match: 'Match' };
  const rows = lines.map((l, i) => [
    i + 1,
    l.product?.name ?? '',
    variantLabel(l.variant),
    l.variant?.sku ?? '',
    l.product?.categoryName ?? '',
    l.system_quantity_at_count,
    l.counted_quantity,
    l.variance,
    l.counted_quantity,
    label[l.kind],
    l.notes ?? '',
  ]);
  const csv = [header, ...rows].map((cols) => cols.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `${reference}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

init();
