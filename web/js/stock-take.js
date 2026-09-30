import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { queueOutbox, countPendingOutbox } from './db.js';
import { initSyncListeners, replayOutbox } from './sync.js';
import { logActivity } from './activity.js';
import { icon } from './icons.js';
import { thumb, stockStatus, renderPagination, pill, breakdownList } from './ui.js';
import { loadCatalog, variantLabel, stockCountReference, formatDate, formatDateTime, recordStockCount } from './catalog.js';

// Four-step stock take: select what to count -> enter physical counts -> review variances
// -> complete. Only the variants selected in step 1 are counted and adjusted; everything
// else keeps its system quantity.
//
// Any role can run a stock take at their OWN location (RLS: stock_counts_insert lets a
// cashier insert at their primary_location_id); only managers/owner can pick a different
// location. Stock is tracked per VARIANT (size/colour/SKU), so each selectable row is one
// variant.
//
// The in-progress count is saved on this device after every change (localStorage), so a
// reload or a dropped connection mid-count doesn't lose work. Completing it is
// offline-capable, same pattern as checkout: if the write fails (or the device is offline),
// the count queues in IndexedDB and replays once connectivity returns (js/sync.js).
let profile = null;
let catalog = null;
let rows = []; // [{ variant, product, systemQty, lastCounted, status }]
let state = null; // see freshState()
let completed = null; // { reference, stockCount, items } after step 4
const view = { term: '', category: '', status: '', page: 1, onlyVariances: false };

const draftKey = () => `subtle-pos-stock-take-draft:${profile.id}`;

function freshState(locationId) {
  return { step: 1, locationId, selected: [], counts: {}, notes: {} };
}

function saveDraft() {
  try {
    if (state.step >= 4 || (state.step === 1 && state.selected.length === 0)) localStorage.removeItem(draftKey());
    else localStorage.setItem(draftKey(), JSON.stringify(state));
  } catch {
    // storage full or blocked -- the count still works, it just won't survive a reload
  }
}

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(draftKey()) ?? 'null');
  } catch {
    return null;
  }
}

async function init() {
  registerServiceWorker();

  const auth = await requireAuth();
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  catalog = await loadCatalog(getClient());

  const draft = loadDraft();
  const canUseDraftLocation = draft && catalog.locations.some((l) => l.id === draft.locationId);
  state = canUseDraftLocation ? draft : freshState(profile.primary_location_id ?? catalog.locations[0]?.id);

  initSyncListeners(refreshStatusBanner);
  window.addEventListener('online', refreshStatusBanner);
  window.addEventListener('offline', refreshStatusBanner);
  await refreshStatusBanner();

  await loadRows();

  // stock-take.html?variant=<id> (from the variant page's "Stock count"): count just that
  // item -- added to any unfinished count rather than throwing it away.
  const only = new URLSearchParams(location.search).get('variant');
  if (only && rows.some((r) => r.variant.id === only)) {
    if (!state.selected.includes(only)) state.selected.push(only);
    state.step = 2;
    saveDraft();
    history.replaceState(null, '', 'stock-take.html');
    render();
    return;
  }

  if (canUseDraftLocation && state.selected.length) {
    document.getElementById('status-banner').innerHTML = `<div class="status-banner ok">Picked up your unfinished stock take (${state.selected.length} items). <button type="button" class="link-danger" id="discard-draft">Discard it</button></div>`;
    document.getElementById('discard-draft').addEventListener('click', () => {
      state = freshState(state.locationId);
      saveDraft();
      document.getElementById('status-banner').innerHTML = '';
      render();
    });
  }
  render();
}

async function loadRows() {
  const client = getClient();
  // Last completed count per variant at this location, for the "Last counted" column.
  const [{ data: counts }, { data: countItems }] = await Promise.all([
    client.from('stock_counts').select('id, location_id, status, completed_at, created_at').eq('location_id', state.locationId),
    client.from('stock_count_items').select('stock_count_id, variant_id'),
  ]);
  const completedAt = Object.fromEntries((counts ?? []).filter((c) => c.status === 'completed').map((c) => [c.id, c.completed_at ?? c.created_at]));
  const lastCounted = {};
  for (const item of countItems ?? []) {
    const at = completedAt[item.stock_count_id];
    if (at && (!lastCounted[item.variant_id] || at > lastCounted[item.variant_id])) lastCounted[item.variant_id] = at;
  }

  rows = catalog.products
    .filter((p) => p.is_active !== false)
    .flatMap((p) =>
      p.variants
        .filter((v) => v.is_active !== false)
        .map((v) => {
          const systemQty = catalog.qty(v.id, state.locationId);
          return { variant: v, product: p, systemQty, lastCounted: lastCounted[v.id] ?? null, status: stockStatus(systemQty, v.reorder_threshold) };
        })
    )
    .sort((a, b) => a.product.name.localeCompare(b.product.name) || (a.variant.sku ?? '').localeCompare(b.variant.sku ?? ''));

  // A draft may reference variants since removed.
  const known = new Set(rows.map((r) => r.variant.id));
  state.selected = state.selected.filter((id) => known.has(id));
}

function selectedRows() {
  const set = new Set(state.selected);
  return rows.filter((r) => set.has(r.variant.id));
}

function counted(row) {
  const value = state.counts[row.variant.id];
  return value === '' || value == null ? null : Number(value);
}

function varianceOf(row) {
  const c = counted(row);
  return c == null ? null : c - row.systemQty;
}

function go(step) {
  state.step = step;
  saveDraft();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  document.querySelectorAll('#stepper li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('done', n < state.step);
    li.classList.toggle('current', n === state.step);
    li.querySelector('.step-dot').innerHTML = n < state.step ? icon('check', { size: 18 }) : String(n);
    if (n === 1) li.querySelector('small').textContent = n < state.step ? `${state.selected.length} items selected` : 'Choose items to count';
    li.toggleAttribute('aria-current', n === state.step);
  });
  ({ 1: renderSelect, 2: renderCount, 3: renderReview, 4: renderComplete })[state.step]();
}

// ---------- step 1: select ----------
function filteredRows() {
  return rows.filter((r) => {
    if (view.category && r.product.category_id !== view.category) return false;
    if (view.status && r.status !== view.status) return false;
    if (!view.term) return true;
    return r.product.name.toLowerCase().includes(view.term) || (r.variant.sku ?? '').toLowerCase().includes(view.term) || (r.variant.barcode ?? '') === view.term;
  });
}

function renderSelect() {
  const isManager = profile.role !== 'cashier';
  const main = document.getElementById('step-main');
  main.innerHTML = `
    <div class="card-header">
      <div>
        <h2 class="card-title">Select products for stock take</h2>
        <p class="card-subtitle">Choose the items you want to include in this count.</p>
      </div>
      <label class="field" style="min-width: 220px;">Location
        <select id="location-select" ${isManager ? '' : 'disabled'}>${catalog.locations.map((l) => `<option value="${l.id}" ${l.id === state.locationId ? 'selected' : ''}>${l.name}</option>`).join('')}</select>
      </label>
    </div>
    <div class="toolbar">
      <label class="search">${icon('search')}<input type="search" id="st-search" placeholder="Search products, SKU or barcode…" aria-label="Search" value="${view.term}" /></label>
      <select id="st-category" aria-label="Category"><option value="">All categories</option>${catalog.categories.map((c) => `<option value="${c.id}" ${view.category === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
      <select id="st-status" aria-label="Stock status">
        <option value="">All stock status</option>
        ${[['in', 'In stock'], ['low', 'Low stock'], ['out', 'Out of stock']].map(([v, l]) => `<option value="${v}" ${view.status === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th style="width: 40px;"><input type="checkbox" id="st-check-page" aria-label="Select all on this page" /></th>
          <th>Product</th><th>SKU</th><th>Category</th><th class="num">Current stock</th><th>Last counted</th>
        </tr></thead>
        <tbody id="st-select-body"></tbody>
      </table>
    </div>
    <div class="pagination" id="st-pagination"></div>`;

  document.getElementById('location-select').addEventListener('change', async (e) => {
    state = freshState(e.target.value);
    await loadRows();
    saveDraft();
    render();
  });
  const search = document.getElementById('st-search');
  search.addEventListener('input', () => {
    view.term = search.value.trim().toLowerCase();
    view.page = 1;
    drawSelectRows();
  });
  document.getElementById('st-category').addEventListener('change', (e) => {
    view.category = e.target.value;
    view.page = 1;
    drawSelectRows();
  });
  document.getElementById('st-status').addEventListener('change', (e) => {
    view.status = e.target.value;
    view.page = 1;
    drawSelectRows();
  });
  document.getElementById('st-check-page').addEventListener('change', (e) => {
    const pageIds = [...document.querySelectorAll('#st-select-body input[type="checkbox"]')].map((c) => c.dataset.id);
    const set = new Set(state.selected);
    pageIds.forEach((id) => (e.target.checked ? set.add(id) : set.delete(id)));
    state.selected = [...set];
    saveDraft();
    drawSelectRows();
    renderSelectSide();
  });

  drawSelectRows();
  renderSelectSide();
  document.getElementById('step-footer').hidden = true;
}

function drawSelectRows() {
  const visible = filteredRows();
  const { from, to, page } = renderPagination(document.getElementById('st-pagination'), {
    total: visible.length,
    page: view.page,
    noun: 'items',
    onPage: (n) => {
      view.page = n;
      drawSelectRows();
    },
  });
  view.page = page;
  const set = new Set(state.selected);
  const pageRows = visible.slice(from, to);
  document.getElementById('st-select-body').innerHTML =
    pageRows
      .map(
        (r) => `
      <tr class="selectable${set.has(r.variant.id) ? ' is-selected' : ''}" data-id="${r.variant.id}">
        <td><input type="checkbox" data-id="${r.variant.id}" ${set.has(r.variant.id) ? 'checked' : ''} aria-label="Include ${r.product.name} ${variantLabel(r.variant)}" /></td>
        <td><div class="cell-product">${thumb(r.product.image_url, '', 'sm')}<span><span class="name">${r.product.name}</span><span class="sub">${variantLabel(r.variant) || '—'}</span></span></div></td>
        <td class="muted nowrap">${r.variant.sku}</td>
        <td class="muted">${r.product.categoryName || '—'}</td>
        <td class="num">${r.systemQty}</td>
        <td class="muted nowrap">${r.lastCounted ? formatDate(r.lastCounted) : 'Never'}</td>
      </tr>`
      )
      .join('') || '<tr><td colspan="6" class="muted" style="text-align: center; padding: 28px;">Nothing matches these filters.</td></tr>';

  const pageBox = document.getElementById('st-check-page');
  const pageChecked = pageRows.filter((r) => set.has(r.variant.id)).length;
  pageBox.checked = pageRows.length > 0 && pageChecked === pageRows.length;
  pageBox.indeterminate = pageChecked > 0 && pageChecked < pageRows.length;

  document.querySelectorAll('#st-select-body tr.selectable').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      const id = tr.dataset.id;
      const selected = new Set(state.selected);
      const box = tr.querySelector('input');
      const include = e.target === box ? box.checked : !selected.has(id);
      include ? selected.add(id) : selected.delete(id);
      state.selected = [...selected];
      saveDraft();
      drawSelectRows();
      renderSelectSide();
    });
  });
}

function renderSelectSide() {
  const picked = selectedRows();
  const totalStock = picked.reduce((s, r) => s + r.systemQty, 0);
  const lastDates = picked.map((r) => r.lastCounted).filter(Boolean).sort();
  const minutes = Math.max(1, Math.round(picked.length * 0.4));
  document.getElementById('step-side').innerHTML = `
    <section class="card">
      <div class="side-actions">
        <button type="button" class="ghost" id="st-select-all">Select all</button>
        <button type="button" class="danger-ghost" id="st-clear">Clear selection</button>
      </div>
      <h3 class="side-title">Stock take summary</h3>
      <ul class="summary-list">
        <li><span class="stat-icon tone-blue">${icon('clipboard', { size: 22 })}</span><span><small>Items selected</small><strong>${picked.length}</strong><small>of ${rows.length} items</small></span></li>
        <li><span class="stat-icon tone-green">${icon('box', { size: 22 })}</span><span><small>Total current stock</small><strong>${totalStock}</strong><small>units</small></span></li>
        <li><span class="stat-icon tone-purple">${icon('clock', { size: 22 })}</span><span><small>Last counted</small><strong>${lastDates.length ? formatDate(lastDates[0]) : 'Never'}</strong><small>${lastDates.length ? 'oldest in selection' : 'no previous count'}</small></span></li>
        <li><span class="stat-icon tone-amber">${icon('clock', { size: 22 })}</span><span><small>Estimated time</small><strong>${picked.length ? `${minutes}–${Math.ceil(minutes * 1.4)} mins` : '—'}</strong><small>to complete</small></span></li>
      </ul>
    </section>
    <section class="card">
      <h3 class="side-title">Quick select</h3>
      <div class="quick-grid">
        <button type="button" class="ghost" data-quick="all">All products</button>
        <button type="button" class="ghost" data-quick="filtered">Current filter</button>
        <button type="button" class="ghost" data-quick="low">${icon('alert', { size: 16 })} Low stock</button>
        <button type="button" class="ghost" data-quick="out">${icon('box', { size: 16 })} Out of stock</button>
      </div>
      <button type="button" class="primary lg" id="st-continue" style="width: 100%; margin-top: 16px;" ${picked.length ? '' : 'disabled'}>Continue to count ${icon('chevronRight', { size: 18 })}</button>
    </section>`;

  const setSelection = (list) => {
    state.selected = list.map((r) => r.variant.id);
    saveDraft();
    drawSelectRows();
    renderSelectSide();
  };
  document.getElementById('st-select-all').addEventListener('click', () => setSelection(rows));
  document.getElementById('st-clear').addEventListener('click', () => setSelection([]));
  document.querySelectorAll('[data-quick]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const q = btn.dataset.quick;
      if (q === 'all') setSelection(rows);
      else if (q === 'filtered') setSelection(filteredRows());
      else setSelection(rows.filter((r) => r.status === q));
    })
  );
  document.getElementById('st-continue').addEventListener('click', () => go(2));
}

// ---------- step 2: count ----------
function varianceBadge(v) {
  if (v == null) return '<span class="variance variance-none">—</span>';
  if (v === 0) return '<span class="variance variance-zero">0</span>';
  return `<span class="variance ${v > 0 ? 'variance-over' : 'variance-under'}">${v > 0 ? '+' : ''}${v}</span>`;
}

function renderCount() {
  const picked = selectedRows();
  const main = document.getElementById('step-main');
  main.innerHTML = `
    <div class="card-header">
      <div>
        <h2 class="card-title">Enter physical stock counts</h2>
        <p class="card-subtitle">Count each item on the shelf and enter the actual number.</p>
      </div>
      <button type="button" class="ghost" id="use-previous">${icon('undo', { size: 18 })} Use system quantities</button>
    </div>
    <div class="table-wrap">
      <table class="count-table">
        <thead><tr><th>Product</th><th>SKU</th><th class="num">Current stock<br /><span class="muted" style="font-weight: 400;">(system)</span></th><th>Physical count<br /><span class="muted" style="font-weight: 400;">(actual)</span></th><th>Variance</th><th>Notes</th></tr></thead>
        <tbody>
          ${picked
            .map(
              (r) => `
            <tr data-id="${r.variant.id}">
              <td><div class="cell-product">${thumb(r.product.image_url, '', 'sm')}<span><span class="name">${r.product.name}</span><span class="sub">${variantLabel(r.variant) || '—'}</span></span></div></td>
              <td class="muted nowrap">${r.variant.sku}</td>
              <td class="num">${r.systemQty}</td>
              <td><input type="number" class="count-input" min="0" step="1" inputmode="numeric" value="${state.counts[r.variant.id] ?? ''}" aria-label="Physical count for ${r.variant.sku}" /></td>
              <td class="variance-cell">${varianceBadge(varianceOf(r))}</td>
              <td><input type="text" class="note-input" placeholder="Add note (optional)" value="${(state.notes[r.variant.id] ?? '').replaceAll('"', '&quot;')}" aria-label="Note for ${r.variant.sku}" /></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;

  main.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const row = picked.find((r) => r.variant.id === id);
    const input = tr.querySelector('.count-input');
    input.addEventListener('input', () => {
      const value = input.value.trim();
      state.counts[id] = value === '' ? '' : Math.max(0, Math.floor(Number(value)));
      tr.querySelector('.variance-cell').innerHTML = varianceBadge(varianceOf(row));
      saveDraft();
      renderCountSide();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const inputs = [...main.querySelectorAll('.count-input')];
      inputs[inputs.indexOf(input) + 1]?.focus();
    });
    tr.querySelector('.note-input').addEventListener('input', (e) => {
      state.notes[id] = e.target.value;
      saveDraft();
    });
  });
  document.getElementById('use-previous').addEventListener('click', () => {
    for (const r of picked) if (state.counts[r.variant.id] === '' || state.counts[r.variant.id] == null) state.counts[r.variant.id] = r.systemQty;
    saveDraft();
    renderCount();
  });

  renderCountSide();
  renderFooter({ back: 1, nextLabel: 'Continue to review', next: 3, nextEnabled: () => picked.every((r) => counted(r) != null) });
  main.querySelector('.count-input')?.focus();
}

function renderCountSide() {
  const picked = selectedRows();
  const done = picked.filter((r) => counted(r) != null);
  const systemTotal = picked.reduce((s, r) => s + r.systemQty, 0);
  const countedTotal = done.reduce((s, r) => s + counted(r), 0);
  const variance = done.reduce((s, r) => s + varianceOf(r), 0);
  const withVariance = done.filter((r) => varianceOf(r) !== 0).length;
  const pct = picked.length ? Math.round((done.length / picked.length) * 100) : 0;
  document.getElementById('step-side').innerHTML = `
    <section class="card">
      <h3 class="side-title">Count progress</h3>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width: ${pct}%"></span></div>
      <div class="progress-meta"><span>${done.length} of ${picked.length} items counted</span><strong>${pct}%</strong></div>
    </section>
    <section class="card">
      <h3 class="side-title">Running summary</h3>
      <ul class="summary-list">
        <li><span class="stat-icon tone-blue">${icon('box', { size: 22 })}</span><span><small>Total items (system)</small><strong>${systemTotal}</strong><small>units</small></span></li>
        <li><span class="stat-icon tone-green">${icon('clipboard', { size: 22 })}</span><span><small>Total items (counted)</small><strong>${countedTotal}</strong><small>units</small></span></li>
        <li><span class="stat-icon tone-red">${icon('clipboard', { size: 22 })}</span><span><small>Total variance</small><strong class="${variance < 0 ? 'text-danger' : variance > 0 ? 'text-success' : ''}">${variance > 0 ? '+' : ''}${variance}</strong><small>units</small></span></li>
        <li><span class="stat-icon tone-amber">${icon('alert', { size: 22 })}</span><span><small>Items with variance</small><strong>${withVariance}</strong><small>of ${picked.length} items</small></span></li>
      </ul>
      <div class="callout" style="margin-top: 14px;">${icon('alert', { size: 18 })}<span>Double-check high-value items and anything with a large variance before continuing.</span></div>
    </section>`;
  const next = document.getElementById('footer-next');
  if (next) next.disabled = !picked.every((r) => counted(r) != null);
}

function renderFooter({ back, next, nextLabel, nextEnabled, onNext }) {
  const footer = document.getElementById('step-footer');
  footer.hidden = false;
  footer.innerHTML = `
    <button type="button" class="ghost lg" id="footer-back">${icon('chevronLeft', { size: 18 })} Back</button>
    <button type="button" class="primary lg" id="footer-next" ${nextEnabled() ? '' : 'disabled'}>${nextLabel} ${icon('chevronRight', { size: 18 })}</button>`;
  document.getElementById('footer-back').addEventListener('click', () => go(back));
  document.getElementById('footer-next').addEventListener('click', onNext ?? (() => go(next)));
}

// ---------- step 3: review ----------
function statusFor(v) {
  if (v < 0) return pill('danger', 'Shortage');
  if (v > 0) return pill('warning', 'Overage');
  return pill('success', 'Match');
}

function renderReview() {
  const picked = selectedRows();
  const withVariance = picked.filter((r) => varianceOf(r) !== 0);
  const shown = view.onlyVariances ? withVariance : picked;
  const main = document.getElementById('step-main');
  main.innerHTML = `
    <div class="card-header">
      <div>
        <h2 class="card-title">Review stock take</h2>
        <p class="card-subtitle">Check the counted quantities and variances before completing.</p>
      </div>
      <button type="button" class="ghost" id="edit-counts">${icon('pencil', { size: 16 })} Edit counts</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Product</th><th>SKU</th><th class="num">System stock</th><th class="num">Physical count</th><th>Variance</th><th>Status</th><th>Notes</th></tr></thead>
        <tbody>
          ${shown
            .map(
              (r) => `
            <tr>
              <td><div class="cell-product">${thumb(r.product.image_url, '', 'sm')}<span><span class="name">${r.product.name}</span><span class="sub">${variantLabel(r.variant) || '—'}</span></span></div></td>
              <td class="muted nowrap">${r.variant.sku}</td>
              <td class="num">${r.systemQty}</td>
              <td class="num">${counted(r)}</td>
              <td>${varianceBadge(varianceOf(r))}</td>
              <td>${statusFor(varianceOf(r))}</td>
              <td class="muted">${state.notes[r.variant.id] || '—'}</td>
            </tr>`
            )
            .join('') || '<tr><td colspan="7" class="muted" style="text-align: center; padding: 28px;">No variances — every count matches the system.</td></tr>'}
        </tbody>
      </table>
    </div>
    ${
      withVariance.length
        ? `<div class="callout variance-callout">${icon('alert', { size: 22 })}<span><strong>${withVariance.length} item${withVariance.length === 1 ? '' : 's'} with variances</strong><br />Please review the shortages and overages before completing.</span>
      <span class="callout-actions"><button type="button" class="ghost" data-filter="variances">Show only variances</button><button type="button" class="outline-brand" data-filter="all">Show all items</button></span></div>`
        : ''
    }`;
  document.getElementById('edit-counts').addEventListener('click', () => go(2));
  main.querySelectorAll('[data-filter]').forEach((btn) =>
    btn.addEventListener('click', () => {
      view.onlyVariances = btn.dataset.filter === 'variances';
      renderReview();
    })
  );

  const withVar = picked.map((r) => ({ ...r, variance: varianceOf(r) }));
  const shortages = withVar.filter((r) => r.variance < 0);
  const overages = withVar.filter((r) => r.variance > 0);
  const systemTotal = picked.reduce((s, r) => s + r.systemQty, 0);
  const countedTotal = picked.reduce((s, r) => s + counted(r), 0);
  const variance = countedTotal - systemTotal;
  document.getElementById('step-side').innerHTML = `
    <section class="card">
      <h3 class="side-title">Stock take summary</h3>
      <ul class="summary-list">
        <li><span class="stat-icon tone-blue">${icon('box', { size: 22 })}</span><span><small>Total items</small><strong>${picked.length}</strong><small>of ${picked.length} counted</small></span></li>
        <li><span class="stat-icon tone-green">${icon('clipboard', { size: 22 })}</span><span><small>Total system stock</small><strong>${systemTotal}</strong><small>units</small></span></li>
        <li><span class="stat-icon tone-purple">${icon('clipboard', { size: 22 })}</span><span><small>Total counted stock</small><strong>${countedTotal}</strong><small>units</small></span></li>
        <li><span class="stat-icon tone-red">${icon('clipboard', { size: 22 })}</span><span><small>Total variance</small><strong class="${variance < 0 ? 'text-danger' : variance > 0 ? 'text-success' : ''}">${variance > 0 ? '+' : ''}${variance}</strong><small>units</small></span></li>
      </ul>
    </section>
    <section class="card">
      <h3 class="side-title">Variance breakdown</h3>
      ${breakdownList(shortages, overages, picked.length - shortages.length - overages.length)}
    </section>`;

  renderFooter({ back: 2, nextLabel: 'Complete stock take', nextEnabled: () => true, onNext: completeStockTake });
}

// ---------- complete ----------
async function completeStockTake() {
  const next = document.getElementById('footer-next');
  next.disabled = true;
  const picked = selectedRows();
  const items = picked.map((r) => ({
    variant_id: r.variant.id,
    counted_quantity: counted(r),
    system_quantity_at_count: r.systemQty,
    notes: (state.notes[r.variant.id] ?? '').trim(),
  }));

  let result;
  let queued = false;
  try {
    if (!navigator.onLine) throw new Error('offline');
    result = await recordStockCount(getClient(), { locationId: state.locationId, countedBy: profile.id, items });
  } catch {
    // Same offline contract as before: queue the whole count and let sync.js replay it.
    const countId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const stockCount = { id: countId, location_id: state.locationId, status: 'draft', counted_by: profile.id, sync_status: 'synced', created_at: nowIso, completed_at: nowIso };
    const rowsOut = items.map((i) => ({ id: crypto.randomUUID(), stock_count_id: countId, ...i, notes: i.notes || null }));
    await queueOutbox({ id: countId, entity_type: 'stock_count', entity_id: countId, status: 'pending', created_at: nowIso, payload: { stockCount, items: rowsOut } });
    result = { stockCount, items: rowsOut };
    queued = true;
  }

  const changed = items.filter((i) => i.counted_quantity !== i.system_quantity_at_count).length;
  await logActivity(
    profile,
    'stock_change',
    `${profile.full_name} completed a stock take (${changed} item${changed === 1 ? '' : 's'} adjusted)`,
    { stock_count_id: result.stockCount.id, location_id: state.locationId, changed_count: changed }
  );

  completed = { reference: stockCountReference(result.stockCount), stockCount: result.stockCount, queued, picked, counts: { ...state.counts } };
  document.getElementById('status-banner').innerHTML = '';
  state.step = 4;
  saveDraft(); // clears the draft
  render();
  await refreshStatusBanner();
  replayOutbox(refreshStatusBanner);
}

function renderComplete() {
  if (!completed) {
    // A reload after completing lands here with no in-memory result -- start fresh.
    state = freshState(state.locationId);
    saveDraft();
    return render();
  }
  const { picked, counts } = completed;
  const withV = picked
    .map((r) => ({ ...r, countedQty: counts[r.variant.id], variance: counts[r.variant.id] - r.systemQty }))
    .filter((r) => r.variance !== 0);
  const shortages = withV.filter((r) => r.variance < 0);
  const overages = withV.filter((r) => r.variance > 0);
  const countedUnits = picked.reduce((s, r) => s + counts[r.variant.id], 0);
  const systemUnits = picked.reduce((s, r) => s + r.systemQty, 0);

  document.getElementById('step-main').innerHTML = `
    <div class="success-banner">
      <span class="success-mark" style="width: 60px; height: 60px;">${icon('check', { size: 32 })}</span>
      <div>
        <h2>Stock take complete!</h2>
        <p>${completed.queued ? 'Saved on this device — it will be posted and inventory updated as soon as you are back online.' : 'Your stock take has been recorded and inventory levels have been updated.'}</p>
        <dl class="meta-row">
          <div><dt>Reference</dt><dd>${completed.reference}</dd></div>
          <div><dt>Date &amp; time</dt><dd>${formatDateTime(completed.stockCount.completed_at)}</dd></div>
          <div><dt>Counted by</dt><dd>${profile.full_name}</dd></div>
        </dl>
      </div>
    </div>
    <div class="card-header" style="margin-top: 22px;">
      <div><h2 class="card-title">Adjusted items</h2><p class="card-subtitle">These items had variances and have been updated.</p></div>
      ${completed.queued ? '' : `<a class="button ghost" href="stock-take-report.html?id=${completed.stockCount.id}">${icon('receipt', { size: 18 })} View stock take report</a>`}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Product</th><th>SKU</th><th class="num">System stock</th><th class="num">Counted stock</th><th>Variance</th><th>Adjustment</th><th class="num">New stock</th></tr></thead>
        <tbody>
          ${
            withV
              .map(
                (r) => `
            <tr>
              <td><div class="cell-product">${thumb(r.product.image_url, '', 'sm')}<span><span class="name">${r.product.name}</span><span class="sub">${variantLabel(r.variant) || '—'}</span></span></div></td>
              <td class="muted nowrap">${r.variant.sku}</td>
              <td class="num">${r.systemQty}</td>
              <td class="num">${r.countedQty}</td>
              <td>${varianceBadge(r.variance)}</td>
              <td>${r.variance < 0 ? pill('danger', '↓ Decreased') : pill('success', '↑ Increased')}</td>
              <td class="num"><strong>${r.countedQty}</strong></td>
            </tr>`
              )
              .join('') || '<tr><td colspan="7" class="muted" style="text-align: center; padding: 28px;">Nothing needed adjusting — every count matched.</td></tr>'
          }
        </tbody>
      </table>
    </div>`;

  document.getElementById('step-side').innerHTML = `
    <section class="card">
      <h3 class="side-title">Stock take summary</h3>
      <div class="mini-stats">
        <div class="tone-blue-soft"><strong>${picked.length}</strong><small>Items counted</small></div>
        <div class="tone-green-soft"><strong>${countedUnits}</strong><small>Units counted<br />of ${systemUnits} system units</small></div>
        <div class="tone-red-soft"><strong>${withV.length}</strong><small>Items adjusted</small></div>
        <div><strong>${picked.length - withV.length}</strong><small>Matched exactly</small></div>
      </div>
    </section>
    <section class="card">
      <h3 class="side-title">Variance summary</h3>
      ${breakdownList(shortages, overages, picked.length - withV.length)}
      <div class="callout" style="margin-top: 14px;">${icon('alert', { size: 18 })}<span><strong>What happens next?</strong><br />Inventory now shows the counted quantities. You can view the full report or start a new stock take.</span></div>
    </section>`;

  const footer = document.getElementById('step-footer');
  footer.hidden = false;
  footer.innerHTML = `
    <button type="button" class="ghost lg" id="start-new">${icon('undo', { size: 18 })} Start new stock take</button>
    <span class="footer-right">
      ${profile.role !== 'cashier' ? '<a class="button ghost lg" href="inventory.html">View inventory</a>' : ''}
      ${completed.queued ? '' : `<a class="button primary lg" href="stock-take-report.html?id=${completed.stockCount.id}">View full report ${icon('chevronRight', { size: 18 })}</a>`}
    </span>`;
  document.getElementById('start-new').addEventListener('click', async () => {
    completed = null;
    catalog = await loadCatalog(getClient());
    state = freshState(state.locationId);
    await loadRows();
    go(1);
  });
}

async function refreshStatusBanner() {
  const pending = await countPendingOutbox();
  if (pending === 0) return; // don't stomp other messages with an empty banner
  const banner = document.getElementById('status-banner');
  banner.innerHTML = !navigator.onLine
    ? `<div class="status-banner offline">Offline — ${pending} item${pending === 1 ? '' : 's'} queued and will sync once you're back online.</div>`
    : `<div class="status-banner pending">Syncing ${pending} queued item${pending === 1 ? '' : 's'}…</div>`;
}

init();
