import { formatCents } from './money.js';

// Renders a Subtle Accessories-branded receipt overlay after a completed sale. Printable
// via window.print() -- the @media print rules in css/style.css hide everything else on
// the page so only the receipt paper itself comes out (works with a regular printer; a
// thermal receipt printer is a later, hardware-specific integration, not built here).
export function showReceipt({ sale, lines, locationName, cashierName }) {
  const existing = document.getElementById('receipt-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'receipt-overlay';
  overlay.className = 'receipt-overlay';

  const dateStr = new Date(sale.created_at).toLocaleString();
  const shortId = sale.id.slice(0, 8).toUpperCase();

  overlay.innerHTML = `
    <div class="receipt-paper">
      <img src="img/logo.png" alt="Subtle Accessories" class="receipt-logo" />
      <p class="tagline">${locationName ?? ''}</p>
      <hr />
      <div class="receipt-line"><span>Receipt #</span><span>${shortId}</span></div>
      <div class="receipt-line"><span>Date</span><span>${dateStr}</span></div>
      <div class="receipt-line"><span>Served by</span><span>${cashierName ?? ''}</span></div>
      <div class="receipt-line"><span>Sale type</span><span>${sale.sale_type}</span></div>
      <hr />
      ${lines
        .map(
          (l) => `
        <div class="receipt-line">
          <span class="receipt-item-name">${l.quantity} × ${l.name}${l.variantLabel ? ` (${l.variantLabel})` : ''}</span>
          <span>${formatCents(l.quantity * l.unitPriceCents, sale.currency)}</span>
        </div>`
        )
        .join('')}
      <hr />
      <div class="receipt-totals">
        <div class="receipt-line"><span>Subtotal</span><span>${formatCents(sale.subtotal_cents, sale.currency)}</span></div>
        ${sale.discount_cents ? `<div class="receipt-line"><span>Discount</span><span>-${formatCents(sale.discount_cents, sale.currency)}</span></div>` : ''}
        ${sale.tax_cents ? `<div class="receipt-line"><span>Tax</span><span>${formatCents(sale.tax_cents, sale.currency)}</span></div>` : ''}
        <div class="receipt-line grand"><span>TOTAL</span><span>${formatCents(sale.total_cents, sale.currency)}</span></div>
      </div>
      <p class="receipt-footer">Thank you for shopping with Subtle Accessories!<br />All sales are final unless returned with this receipt.</p>
      <div class="receipt-actions">
        <button type="button" class="ghost" id="receipt-close">Close</button>
        <button type="button" class="primary" id="receipt-print">Print</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById('receipt-close').addEventListener('click', () => overlay.remove());
  document.getElementById('receipt-print').addEventListener('click', () => window.print());
}
