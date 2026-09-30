import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents, toCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { logActivity } from './activity.js';
import { icon } from './icons.js';
import { thumb, stockStatus, stockPill, renderPagination } from './ui.js';
import { loadCatalog, uploadProductPhoto } from './catalog.js';

// Products list (plus, until Settings exists, discount codes and the manager PIN).
// Manager/owner only -- RLS enforces this independently (products/product_variants/
// product_prices writes all require is_manager_or_owner(), and product_cost_history is
// manager/owner-only to even read), this requireAuth call just gives a cashier who
// wanders here a clean message.
//
// Adding and editing a product happen on product.html; each row here opens it. Deleted
// (inactive) products are hidden -- their history stays in the database.
let profile = null;
let products = [];
const view = { term: '', category: '', status: '', page: 1 };

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner', 'admin']);
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  const catalog = await loadCatalog(getClient());
  document.getElementById('filter-category').innerHTML = `<option value="">All categories</option>${catalog.categories.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}`;
  products = catalog.products
    .filter((p) => p.is_active !== false)
    .map((p) => {
      const variants = p.variants.filter((v) => v.is_active !== false);
      const totalStock = variants.reduce((sum, v) => sum + catalog.qty(v.id), 0);
      return { ...p, variants, totalStock, status: variants.length ? stockStatus(totalStock) : 'out' };
    })
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.name.localeCompare(b.name));

  const search = document.getElementById('product-search');
  search.addEventListener('input', () => {
    view.term = search.value.trim().toLowerCase();
    view.page = 1;
    drawProductTable();
  });
  document.getElementById('filter-category').addEventListener('change', (e) => {
    view.category = e.target.value;
    view.page = 1;
    drawProductTable();
  });
  document.getElementById('filter-status').addEventListener('change', (e) => {
    view.status = e.target.value;
    view.page = 1;
    drawProductTable();
  });
  document.getElementById('discount-code-form').addEventListener('submit', handleCreateDiscountCode);
  document.getElementById('pin-form').addEventListener('submit', handleSetManagerPin);

  updatePhotoNotice();
  drawProductTable();
  await renderDiscountCodesList();
}

// "N products have no photo yet" with a one-click filter to list just those.
function updatePhotoNotice() {
  const missing = products.filter((p) => !p.image_url).length;
  const notice = document.getElementById('photo-notice');
  notice.hidden = missing === 0;
  notice.querySelector('span').textContent = `${missing} product${missing === 1 ? ' has' : 's have'} no photo yet. Tap "Add photo" on a row to upload one.`;
}

function drawProductTable() {
  const filtered = products.filter((p) => {
    if (view.category && p.category_id !== view.category) return false;
    if (view.status === 'nophoto' ? p.image_url : view.status && p.status !== view.status) return false;
    if (!view.term) return true;
    return p.name.toLowerCase().includes(view.term) || (p.brand ?? '').toLowerCase().includes(view.term) || p.variants.some((v) => (v.sku ?? '').toLowerCase().includes(view.term) || (v.barcode ?? '') === view.term);
  });
  const { from, to, page } = renderPagination(document.getElementById('product-pagination'), {
    total: filtered.length,
    page: view.page,
    noun: 'products',
    onPage: (n) => {
      view.page = n;
      drawProductTable();
    },
  });
  view.page = page;

  const tbody = document.getElementById('product-list');
  tbody.innerHTML =
    filtered
      .slice(from, to)
      .map(
        (p) => `
        <tr class="product-row" data-id="${p.id}">
          <td><div class="cell-product">${
            p.image_url
              ? thumb(p.image_url, '', 'md')
              : `<label class="thumb thumb-md thumb-upload" title="Add a photo" aria-label="Add a photo for ${p.name}">${icon('image', { size: 16 })}<span>Add photo</span><input type="file" accept="image/*" class="visually-hidden" data-photo-for="${p.id}" /></label>`
          }<a href="product.html?id=${p.id}" class="product-link"><span class="name">${p.name}</span>${p.brand ? `<span class="sub">${p.brand}</span>` : ''}</a></div></td>
          <td class="muted">${p.categoryName || '—'}</td>
          <td>${p.variants.length}</td>
          <td class="muted nowrap">${p.variants[0]?.sku ?? '—'}</td>
          <td class="num">${p.retail ? formatCents(p.retail.unit_price_cents, p.retail.currency) : '—'}</td>
          <td class="num">${p.totalStock}</td>
          <td>${stockPill(p.status)}</td>
          <td><div class="row-actions"><a class="icon-btn" href="product.html?id=${p.id}" aria-label="Edit ${p.name}" title="Edit">${icon('pencil', { size: 16 })}</a></div></td>
        </tr>`
      )
      .join('') || '<tr><td colspan="8" class="muted" style="text-align: center; padding: 32px;">No products match these filters.</td></tr>';

  tbody.querySelectorAll('input[data-photo-for]').forEach((input) =>
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const label = input.closest('label');
      label.classList.add('is-busy');
      label.querySelector('span').textContent = 'Uploading…';
      try {
        const product = products.find((p) => p.id === input.dataset.photoFor);
        product.image_url = await uploadProductPhoto(getClient(), file, product.id);
        await logActivity(profile, 'product_updated', `${profile.full_name} added a photo for "${product.name}"`, { product_id: product.id });
        updatePhotoNotice();
        drawProductTable();
      } catch (err) {
        label.classList.remove('is-busy');
        label.querySelector('span').textContent = 'Try again';
        label.title = err.message ?? 'Upload failed';
      }
    })
  );

  tbody.querySelectorAll('.product-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a, label, input')) return;
      location.href = `product.html?id=${row.dataset.id}`;
    });
  });
}

// STEP 9 of the fashion-retail evolution (promotions). Any manager/owner can create/toggle
// codes -- RLS on discount_codes mirrors the products tables (is_manager_or_owner()).
// Values are stored as cents/whole-percent under the hood but entered as dollars/percent
// here, same convention as product prices.
async function renderDiscountCodesList() {
  const client = getClient();
  const { data: codes } = await client.from('discount_codes').select('*').order('created_at', { ascending: false });
  const tbody = document.getElementById('discount-code-list-body');

  tbody.innerHTML =
    (codes ?? [])
      .map((c) => {
        const value = c.discount_type === 'percentage' ? `${c.discount_value}%` : formatCents(c.discount_value, 'USD');
        const minSpend = c.min_spend_cents ? formatCents(c.min_spend_cents, 'USD') : '—';
        const validUntil = c.valid_until ? new Date(c.valid_until).toLocaleDateString() : '—';
        return `
        <tr>
          <td>${c.code}</td>
          <td>${c.discount_type}</td>
          <td>${value}</td>
          <td>${minSpend}</td>
          <td>${validUntil}</td>
          <td>${c.is_active ? 'Yes' : 'No'}</td>
          <td><button type="button" class="ghost toggle-discount-btn" data-id="${c.id}" data-active="${c.is_active}">${c.is_active ? 'Deactivate' : 'Activate'}</button></td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="7" style="color: var(--text-muted);">No discount codes yet.</td></tr>';

  tbody.querySelectorAll('.toggle-discount-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleToggleDiscountCode(btn.dataset.id, btn.dataset.active === 'true'));
  });
}

async function handleCreateDiscountCode(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('discount-code-error');
  errorEl.textContent = '';
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const client = getClient();
    const code = form.code.value.trim().toUpperCase();
    const discountType = form.discount_type.value;
    // Percentage is a whole-number percent (e.g. 10 = 10%); fixed amount is a dollar value
    // converted to cents -- same unit-storage split discount_type implies in the migration.
    const discountValue = discountType === 'percentage' ? Number(form.discount_value.value) : toCents(form.discount_value.value);
    const minSpend = form.min_spend.value ? toCents(form.min_spend.value) : null;
    const validUntil = form.valid_until.value || null;

    if (!code) throw new Error('Code is required.');

    await client.from('discount_codes').insert({
      id: crypto.randomUUID(),
      code,
      discount_type: discountType,
      discount_value: discountValue,
      min_spend_cents: minSpend,
      valid_until: validUntil,
      is_active: true,
      created_by: profile.id,
      created_at: new Date().toISOString(),
    });

    await logActivity(profile, 'discount_code_created', `${profile.full_name} created discount code ${code}`, { code });
    form.reset();
    await renderDiscountCodesList();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleToggleDiscountCode(id, currentlyActive) {
  const client = getClient();
  await client.from('discount_codes').update({ is_active: !currentlyActive }).eq('id', id);
  await logActivity(profile, 'discount_code_updated', `${profile.full_name} ${currentlyActive ? 'deactivated' : 'activated'} a discount code`, { discount_code_id: id });
  await renderDiscountCodesList();
}

// Self-service PIN: a manager/owner sets their OWN pin (updates their own user_profiles
// row), never someone else's -- there's no "set another user's PIN" UI, deliberately, since
// verify_manager_pin() only needs to know a PIN belongs to *some* manager/owner, not which
// row set it from where.
async function handleSetManagerPin(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('pin-error');
  const successEl = document.getElementById('pin-success');
  errorEl.textContent = '';
  successEl.textContent = '';
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const pin = form.pin.value.trim();
    if (!/^[0-9]{4,6}$/.test(pin)) throw new Error('PIN must be 4-6 digits.');

    const client = getClient();
    const { error } = await client.from('user_profiles').update({ manager_pin: pin }).eq('id', profile.id);
    if (error) throw error;

    successEl.textContent = 'PIN saved.';
    form.reset();
  } catch (err) {
    // The partial unique index on user_profiles.manager_pin surfaces as a generic
    // constraint-violation error from Postgres -- give the manager a plain-language reason
    // rather than a raw DB error, since "someone else already has this PIN" is the only
    // realistic cause.
    errorEl.textContent = /unique|duplicate/i.test(err.message ?? '') ? 'That PIN is already in use — choose a different one.' : (err.message ?? String(err));
  } finally {
    submitBtn.disabled = false;
  }
}

init();

document.getElementById('show-missing-photos')?.addEventListener('click', () => {
  const select = document.getElementById('filter-status');
  select.value = 'nophoto';
  select.dispatchEvent(new Event('change'));
});
