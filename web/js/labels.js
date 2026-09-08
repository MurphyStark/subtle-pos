// Renders and prints barcode/price labels, one per variant, sized for a standard small
// label printer (50mm x 25mm -- a common Dymo/Zebra direct-thermal label size). Uses the
// browser's native print dialog rather than a PDF-generation library: every modern browser
// offers "Save as PDF" as a print destination, which satisfies "exportable as PDF" without
// adding a heavy dependency -- same approach as receipt.js.
//
// Requires the JsBarcode UMD script to already be loaded on the page (see admin.html) --
// it puts a `JsBarcode` global on window, same CDN-script pattern as the Supabase client.

export function printLabels(items) {
  const existing = document.getElementById('label-print-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'label-print-overlay';
  overlay.innerHTML = items
    .map(
      (item, i) => `
      <div class="print-label">
        <div class="label-product">${item.productName}</div>
        ${item.variantLabel ? `<div class="label-variant">${item.variantLabel}</div>` : ''}
        <svg class="label-barcode" id="label-barcode-${i}"></svg>
        <div class="label-sku">${item.sku}</div>
        <div class="label-price">${item.priceText}</div>
      </div>`
    )
    .join('');

  document.body.appendChild(overlay);

  items.forEach((item, i) => {
    // No manufacturer barcode on file? Encode the SKU itself -- a normal fallback for a
    // shop that generates its own in-house barcodes rather than using a supplier's.
    const value = item.barcode || item.sku;
    try {
      window.JsBarcode(`#label-barcode-${i}`, value, {
        format: 'CODE128',
        displayValue: false,
        height: 34,
        margin: 0,
      });
    } catch (err) {
      console.warn('Could not render barcode for', value, err);
    }
  });

  window.print();

  // 'afterprint' fires whether the user actually printed or cancelled the dialog --
  // either way the overlay's job is done.
  const cleanup = () => {
    overlay.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
}
