import { formatCents } from './money.js';
import { isThermalPrintAvailable, printThermalReceipt } from './thermal-print.js';

// Renders a Subtle Accessories-branded receipt overlay after a completed sale. Printable
// via window.print() -- the @media print rules in css/style.css hide everything else on
// the page so only the receipt paper itself comes out (works with a regular printer).
//
// STEP 7 additions: a plain-text version of the same receipt (receiptToPlainText) backs
// three more delivery options -- WhatsApp (a wa.me link with the receipt pre-filled as the
// message text; this is the offline-friendly default since building the link itself needs
// no network, only actually sending it does), email (a mailto: link that opens the
// device's own mail client with the receipt as the body -- there's no backend email
// service here, so this can't send silently; someone still has to hit send), and thermal
// printing via WebUSB where the browser supports it (see thermal-print.js).
export function receiptToPlainText({ sale, lines, locationName, cashierName }) {
  const dateStr = new Date(sale.created_at).toLocaleString();
  const shortId = sale.id.slice(0, 8).toUpperCase();
  const rows = [
    'SUBTLE ACCESSORIES',
    locationName ?? '',
    '--------------------------------',
    `Receipt #: ${shortId}`,
    `Date: ${dateStr}`,
    `Served by: ${cashierName ?? ''}`,
    `Sale type: ${sale.sale_type}`,
    '--------------------------------',
    ...lines.map(
      (l) =>
        `${l.quantity} x ${l.name}${l.variantLabel ? ` (${l.variantLabel})` : ''} - ${formatCents(l.quantity * l.unitPriceCents, sale.currency)}`
    ),
    '--------------------------------',
    `Subtotal: ${formatCents(sale.subtotal_cents, sale.currency)}`,
  ];
  if (sale.discount_cents) rows.push(`Discount: -${formatCents(sale.discount_cents, sale.currency)}`);
  if (sale.tax_cents) rows.push(`Tax: ${formatCents(sale.tax_cents, sale.currency)}`);
  rows.push(`TOTAL: ${formatCents(sale.total_cents, sale.currency)}`);
  rows.push('', 'Thank you for shopping with Subtle Accessories!');
  return rows.join('\n');
}

export function showReceipt(data) {
  const { sale, lines, locationName, cashierName } = data;
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
      <div class="receipt-actions">
        <button type="button" class="ghost" id="receipt-whatsapp">WhatsApp</button>
        <button type="button" class="ghost" id="receipt-email">Email</button>
        ${isThermalPrintAvailable() ? '<button type="button" class="ghost" id="receipt-thermal">Thermal print</button>' : ''}
      </div>
      <p class="error" id="receipt-share-error" style="margin-top: 0.5rem;"></p>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById('receipt-close').addEventListener('click', () => overlay.remove());
  document.getElementById('receipt-print').addEventListener('click', () => window.print());

  document.getElementById('receipt-whatsapp').addEventListener('click', () => {
    const text = receiptToPlainText(data);
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  });

  document.getElementById('receipt-email').addEventListener('click', () => {
    const text = receiptToPlainText(data);
    window.location.href = `mailto:?subject=${encodeURIComponent(`Subtle Accessories receipt ${shortId}`)}&body=${encodeURIComponent(text)}`;
  });

  const thermalBtn = document.getElementById('receipt-thermal');
  if (thermalBtn) {
    thermalBtn.addEventListener('click', async () => {
      const errorEl = document.getElementById('receipt-share-error');
      errorEl.textContent = '';
      thermalBtn.disabled = true;
      try {
        await printThermalReceipt(receiptToPlainText(data));
      } catch (err) {
        errorEl.textContent = err.message ?? String(err);
      } finally {
        thermalBtn.disabled = false;
      }
    });
  }
}
