import { icon } from './icons.js';

// Shared building blocks for the redesigned pages: stock status pills, KPI stat cards,
// product thumbnails and client-side pagination.

// A variant with no reorder threshold of its own still gets a "Low stock" warning at this
// level -- matches the stock tracker workbook's default reorder level.
export const DEFAULT_LOW_STOCK = 2;

export function stockStatus(qty, threshold) {
  if (qty <= 0) return 'out';
  if (qty <= (threshold ?? DEFAULT_LOW_STOCK)) return 'low';
  return 'in';
}

const STATUS_PILL = {
  in: ['success', 'In stock'],
  low: ['warning', 'Low stock'],
  out: ['danger', 'Out of stock'],
};

export function stockPill(status) {
  const [tone, label] = STATUS_PILL[status];
  return pill(tone, label);
}

export function pill(tone, label) {
  return `<span class="pill pill-${tone}"><span class="pill-dot"></span>${label}</span>`;
}

// tone: blue | green | amber | red | purple | gold
export function statCard({ label, value, sub = '', iconName = 'box', tone = 'blue' }) {
  return `
    <div class="stat-card">
      <span class="stat-icon tone-${tone}">${icon(iconName, { size: 24 })}</span>
      <span class="stat-body">
        <span class="stat-label">${label}</span>
        <span class="stat-value">${value}</span>
        ${sub ? `<span class="stat-sub">${sub}</span>` : ''}
      </span>
    </div>`;
}

export function thumb(url, alt = '', size = 'md') {
  return url
    ? `<img class="thumb thumb-${size}" src="${url}" alt="${alt}" loading="lazy" />`
    : `<span class="thumb thumb-${size} thumb-empty">${icon('image', { size: size === 'lg' ? 28 : 18 })}</span>`;
}

// Renders "Showing 1–10 of 42 <noun>" plus page buttons into `container`, and calls
// onPage(pageNumber) when one is clicked. Returns the slice bounds for the current page.
export function renderPagination(container, { total, page, pageSize = 10, noun = 'items', onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const start = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = Math.min(total, current * pageSize);

  const numbers = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - current) <= 1) numbers.push(n);
    else if (numbers[numbers.length - 1] !== '…') numbers.push('…');
  }

  container.innerHTML = `
    <span class="pagination-summary">Showing ${start}–${end} of ${total} ${noun}</span>
    ${
      pages > 1
        ? `<span class="pagination-pages">
        <button type="button" class="page-btn" data-page="${current - 1}" ${current === 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevronLeft', { size: 18 })}</button>
        ${numbers
          .map((n) =>
            n === '…'
              ? '<span class="page-gap">…</span>'
              : `<button type="button" class="page-btn${n === current ? ' active' : ''}" data-page="${n}"${n === current ? ' aria-current="page"' : ''}>${n}</button>`
          )
          .join('')}
        <button type="button" class="page-btn" data-page="${current + 1}" ${current === pages ? 'disabled' : ''} aria-label="Next page">${icon('chevronRight', { size: 18 })}</button>
      </span>`
        : ''
    }`;
  container.querySelectorAll('.page-btn[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => onPage(Number(btn.dataset.page)));
  });
  return { from: (current - 1) * pageSize, to: current * pageSize, page: current };
}

// Shortages / overages / no-variance list used by the stock take pages. Each item needs a
// numeric `variance` (counted - system).
export function breakdownList(shortages, overages, matched) {
  const units = (list) => {
    const n = Math.abs(list.reduce((s, r) => s + r.variance, 0));
    return `${n} unit${n === 1 ? '' : 's'}`;
  };
  const plural = (n) => `${n} item${n === 1 ? '' : 's'}`;
  return `
    <ul class="breakdown-list">
      <li><span class="dot-icon tone-red">${icon('alert', { size: 16 })}</span><span><strong>Shortages</strong><small>${plural(shortages.length)}</small></span><span>${units(shortages)}</span></li>
      <li><span class="dot-icon tone-green">${icon('check', { size: 16 })}</span><span><strong>Overages</strong><small>${plural(overages.length)}</small></span><span>${units(overages)}</span></li>
      <li><span class="dot-icon tone-neutral">${icon('minus', { size: 16 })}</span><span><strong>No variance</strong><small>${plural(matched)}</small></span><span>—</span></li>
    </ul>`;
}

// Donut chart (inline SVG) for part-of-whole splits. segments: [{ value, color, label }]
export function donut(segments, { centerValue, centerLabel, size = 150 } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments
    .filter((x) => x.value > 0)
    .map((x) => {
      const len = (x.value / total) * c;
      const gap = segments.filter((y) => y.value > 0).length > 1 ? 2 : 0;
      const arc = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${x.color}" stroke-width="18" stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"><title>${x.label}: ${x.value}</title></circle>`;
      offset += len;
      return arc;
    })
    .join('');
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 140 140" role="img" aria-label="${segments.map((x) => `${x.label} ${x.value}`).join(', ')}">
    <circle r="${r}" cx="70" cy="70" fill="none" stroke="#efefec" stroke-width="18" />${arcs}
    <text x="70" y="68" text-anchor="middle" class="donut-value">${centerValue ?? total}</text>
    <text x="70" y="86" text-anchor="middle" class="donut-label">${centerLabel ?? ''}</text>
  </svg>`;
}
