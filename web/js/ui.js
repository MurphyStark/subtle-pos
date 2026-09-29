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
