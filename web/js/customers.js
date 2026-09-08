import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { formatCents } from './money.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { logActivity } from './activity.js';

// STEP 8 of the fashion-retail evolution. Not sensitive financial data -- any authenticated
// role can view or add a customer (RLS: customers_select / customers_write both
// using(true)), same trust level as ringing up a sale.
let profile = null;
let customers = [];

async function init() {
  registerServiceWorker();

  const auth = await requireAuth();
  if (!auth) return;
  profile = auth.profile;
  renderNav(profile);

  document.getElementById('customer-form').addEventListener('submit', handleAddCustomer);
  document.getElementById('customer-search').addEventListener('input', (e) => renderCustomerList(e.target.value));

  await loadCustomers();
}

async function loadCustomers() {
  const client = getClient();
  const { data } = await client.from('customers').select('*').order('name', { ascending: true });
  customers = data ?? [];
  renderCustomerList();
}

async function handleAddCustomer(event) {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('customer-error');
  errorEl.textContent = '';

  try {
    const client = getClient();
    const name = form.name.value.trim();
    const phone = form.phone.value.trim() || null;
    const email = form.email.value.trim() || null;

    if (phone) {
      const { data: existing } = await client.from('customers').select('id').eq('phone', phone);
      if (existing?.[0]) {
        errorEl.textContent = 'A customer with this phone number already exists.';
        return;
      }
    }

    const customerId = crypto.randomUUID();
    await client.from('customers').insert({ id: customerId, name, phone, email });
    await logActivity(profile, 'customer_created', `${profile.full_name} added customer ${name}`, { customer_id: customerId });
    form.reset();
    await loadCustomers();
  } catch (err) {
    errorEl.textContent = err.message ?? String(err);
  }
}

function renderCustomerList(filter = '') {
  const term = filter.trim().toLowerCase();
  const visible = customers.filter(
    (c) => !term || c.name.toLowerCase().includes(term) || (c.phone ?? '').toLowerCase().includes(term)
  );

  const container = document.getElementById('customer-list');
  container.innerHTML =
    `<div class="card"><table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th></th></tr></thead><tbody>` +
    (visible
      .map(
        (c) => `
      <tr>
        <td>${c.name}</td>
        <td>${c.phone ?? '—'}</td>
        <td>${c.email ?? '—'}</td>
        <td><button type="button" class="ghost view-customer-btn" data-id="${c.id}">View history</button></td>
      </tr>`
      )
      .join('') || '<tr><td colspan="4">No customers yet.</td></tr>') +
    `</tbody></table></div>`;

  container.querySelectorAll('.view-customer-btn').forEach((btn) => {
    btn.addEventListener('click', () => renderCustomerDetail(btn.dataset.id));
  });
}

async function renderCustomerDetail(customerId) {
  const client = getClient();
  const customer = customers.find((c) => c.id === customerId);
  const detail = document.getElementById('customer-detail');
  detail.innerHTML = '<p>Loading…</p>';

  const [{ data: sales }, { data: locations }] = await Promise.all([
    client.from('sales').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }),
    client.from('locations').select('id, name'),
  ]);
  const locationName = Object.fromEntries((locations ?? []).map((l) => [l.id, l.name]));

  const totalSpent = (sales ?? []).reduce((sum, s) => sum + s.total_cents, 0);

  detail.innerHTML = `
    <div class="card">
      <h2>${customer.name}</h2>
      <p style="color: var(--text-muted);">${customer.phone ?? ''} ${customer.email ? `· ${customer.email}` : ''}</p>
      <p><strong>${sales?.length ?? 0}</strong> purchase${sales?.length === 1 ? '' : 's'}, total ${formatCents(totalSpent, sales?.[0]?.currency ?? 'USD')}</p>
      <table>
        <thead><tr><th>Date</th><th>Receipt #</th><th>Location</th><th>Total</th></tr></thead>
        <tbody>
          ${
            (sales ?? [])
              .map(
                (s) => `
            <tr>
              <td>${new Date(s.created_at).toLocaleString()}</td>
              <td>${s.id.slice(0, 8).toUpperCase()}</td>
              <td>${locationName[s.location_id] ?? ''}</td>
              <td>${formatCents(s.total_cents, s.currency)}</td>
            </tr>`
              )
              .join('') || '<tr><td colspan="4">No purchases yet.</td></tr>'
          }
        </tbody>
      </table>
    </div>
  `;
}

init();
