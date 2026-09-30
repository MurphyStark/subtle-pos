import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { icon } from './icons.js';
import { statCard, pill, renderPagination } from './ui.js';
import { stockCountReference, formatDateTime, formatDate } from './catalog.js';

// Every stock take this user can see (RLS limits cashiers to their own location's counts,
// and only the admin sees Warehouse counts), newest first, with per-count results worked
// out from its lines.
let records = [];
let showLocation = false;
const view = { term: '', status: '', page: 1 };

async function init() {
  registerServiceWorker();
  const auth = await requireAuth();
  if (!auth) return;
  renderNav(auth.profile);

  const client = getClient();
  const [{ data: counts }, { data: items }, { data: people }, { data: locations }] = await Promise.all([
    client.from('stock_counts').select('*').order('created_at', { ascending: false }),
    client.from('stock_count_items').select('stock_count_id, counted_quantity, system_quantity_at_count'),
    client.from('user_profiles').select('id, full_name'),
    client.from('locations').select('id, name'),
  ]);
  const personName = Object.fromEntries((people ?? []).map((p) => [p.id, p.full_name]));
  const locationName = Object.fromEntries((locations ?? []).map((l) => [l.id, l.name]));
  showLocation = (locations ?? []).length > 1;
  document.getElementById('history-location-head').hidden = !showLocation;

  const itemsByCount = {};
  for (const i of items ?? []) (itemsByCount[i.stock_count_id] ??= []).push(i);

  records = (counts ?? []).map((c) => {
    const lines = itemsByCount[c.id] ?? [];
    const variances = lines.map((l) => l.counted_quantity - l.system_quantity_at_count);
    return {
      ...c,
      reference: stockCountReference(c),
      countedBy: personName[c.counted_by] ?? '—',
      location: locationName[c.location_id] ?? '—',
      itemCount: lines.length,
      unitsCounted: lines.reduce((s, l) => s + l.counted_quantity, 0),
      unitsSystem: lines.reduce((s, l) => s + l.system_quantity_at_count, 0),
      netVariance: variances.reduce((s, v) => s + v, 0),
      shortages: variances.filter((v) => v < 0).length,
      itemsWithVariance: variances.filter((v) => v !== 0).length,
    };
  });

  const completed = records.filter((r) => r.status === 'completed');
  const withIssues = completed.filter((r) => r.itemsWithVariance > 0);
  const pct = (n) => (records.length ? `${((n / records.length) * 100).toFixed(1)}%` : '—');
  document.getElementById('history-stats').innerHTML = [
    statCard({ label: 'Total stock takes', value: records.length, sub: 'All time', iconName: 'clipboard', tone: 'blue' }),
    statCard({ label: 'Completed', value: completed.length, sub: pct(completed.length), iconName: 'check', tone: 'green' }),
    statCard({ label: 'In progress', value: records.length - completed.length, sub: pct(records.length - completed.length), iconName: 'clock', tone: 'amber' }),
    statCard({ label: 'With variances', value: withIssues.length, sub: completed.length ? `${((withIssues.length / completed.length) * 100).toFixed(1)}% of completed` : '—', iconName: 'alert', tone: 'red' }),
  ].join('');

  const search = document.getElementById('history-search');
  search.addEventListener('input', () => {
    view.term = search.value.trim().toLowerCase();
    view.page = 1;
    renderRows();
  });
  document.getElementById('history-status').addEventListener('change', (e) => {
    view.status = e.target.value;
    view.page = 1;
    renderRows();
  });

  renderRows();
  renderSide();
}

function varianceChip(v) {
  if (v === 0) return '<span class="variance variance-zero">0</span>';
  return `<span class="variance ${v > 0 ? 'variance-over' : 'variance-under'}">${v > 0 ? '+' : ''}${v}</span>`;
}

function renderRows() {
  const visible = records.filter((r) => {
    if (view.status && r.status !== view.status) return false;
    if (!view.term) return true;
    return [r.reference, r.countedBy, r.location, formatDateTime(r.completed_at ?? r.created_at)].some((x) => x.toLowerCase().includes(view.term));
  });
  const { from, to, page } = renderPagination(document.getElementById('history-pagination'), {
    total: visible.length,
    page: view.page,
    noun: 'records',
    onPage: (n) => {
      view.page = n;
      renderRows();
    },
  });
  view.page = page;
  document.getElementById('history-body').innerHTML =
    visible
      .slice(from, to)
      .map(
        (r) => `
      <tr>
        <td class="nowrap"><a href="stock-take-report.html?id=${r.id}">${r.reference}</a></td>
        <td class="nowrap">${formatDateTime(r.completed_at ?? r.created_at)}</td>
        <td>${r.countedBy}</td>
        ${showLocation ? `<td class="muted">${r.location}</td>` : ''}
        <td class="num">${r.itemCount}</td>
        <td>${r.status === 'completed' ? varianceChip(r.netVariance) : '—'}</td>
        <td>${r.status === 'completed' ? pill('success', 'Completed') : pill('warning', 'In progress')}</td>
        <td><a class="icon-btn" href="stock-take-report.html?id=${r.id}" aria-label="Open ${r.reference}" title="Open">${icon('chevronRight', { size: 16 })}</a></td>
      </tr>`
      )
      .join('') ||
    `<tr><td colspan="8" class="muted" style="text-align: center; padding: 32px;">${records.length ? 'No stock takes match.' : 'No stock takes yet. <a href="stock-take.html">Start the first one</a>.'}</td></tr>`;
}

function renderSide() {
  const last = records.find((r) => r.status === 'completed');
  const side = document.getElementById('history-side');
  if (!last) {
    side.innerHTML = `<section class="card"><h3 class="side-title">Last stock take</h3><p class="muted">Nothing counted yet.</p></section>`;
    return;
  }
  side.innerHTML = `
    <section class="card">
      <h3 class="side-title">Last stock take summary</h3>
      <div class="side-headline"><strong>${last.reference}</strong>${pill('success', 'Completed')}</div>
      <p class="muted" style="margin: 2px 0 12px;">${formatDateTime(last.completed_at ?? last.created_at)}</p>
      <ul class="summary-list">
        <li><span class="stat-icon tone-blue">${icon('clipboard', { size: 22 })}</span><span><small>Items counted</small><strong>${last.itemCount}</strong></span></li>
        <li><span class="stat-icon tone-green">${icon('box', { size: 22 })}</span><span><small>Units counted</small><strong>${last.unitsCounted}</strong><small>of ${last.unitsSystem} system units</small></span></li>
        <li><span class="stat-icon tone-red">${icon('alert', { size: 22 })}</span><span><small>Total variance</small><strong class="${last.netVariance < 0 ? 'text-danger' : last.netVariance > 0 ? 'text-success' : ''}">${last.netVariance > 0 ? '+' : ''}${last.netVariance}</strong><small>units (${last.shortages} shortage${last.shortages === 1 ? '' : 's'})</small></span></li>
        <li><span class="stat-icon tone-purple">${icon('user', { size: 22 })}</span><span><small>Counted by</small><strong>${last.countedBy}</strong></span></li>
      </ul>
      <a class="button outline-brand" style="width: 100%; margin-top: 14px;" href="stock-take-report.html?id=${last.id}">View full report ${icon('chevronRight', { size: 18 })}</a>
    </section>
    <section class="card">
      <h3 class="side-title">Recent stock takes</h3>
      <ul class="timeline">
        ${records
          .slice(0, 5)
          .map(
            (r) => `<li><span class="timeline-dot ${r.status === 'completed' ? 'is-done' : ''}"></span><span><strong>${r.status === 'completed' ? 'Stock take completed' : 'Stock take started'}</strong><a href="stock-take-report.html?id=${r.id}">${r.reference}</a></span><small>${formatDate(r.completed_at ?? r.created_at)}</small></li>`
          )
          .join('')}
      </ul>
    </section>`;
}

init();
