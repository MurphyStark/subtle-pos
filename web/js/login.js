import { getClient, isDemoMode } from './supabaseClient.js';
import { getCurrentProfile } from './auth.js';
import { registerServiceWorker } from './pwa.js';
import { DEMO_ACCOUNTS, resetDemoData, loadSampleData } from './mockClient.js';
import { logActivity } from './activity.js';
import { roleLabel } from './nav.js';

async function init() {
  registerServiceWorker();

  if (isDemoMode()) {
    renderDemoLogin();
  }

  // Already signed in with a valid profile? Skip straight to checkout.
  const existing = await getCurrentProfile();
  if (existing) {
    window.location.href = 'pos.html';
    return;
  }

  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';

    // Demo mode runs entirely on local sample data -- being offline is fine. Real
    // Supabase auth needs a network round trip.
    if (!isDemoMode() && !navigator.onLine) {
      errorEl.textContent = 'Signing in requires an internet connection the first time on this device.';
      return;
    }

    await signIn(form.email.value.trim(), form.password.value);
  });
}

async function signIn(email, password) {
  const errorEl = document.getElementById('login-error');
  const submitBtn = document.querySelector('#login-form button[type="submit"]');
  submitBtn.disabled = true;

  const client = getClient();
  const { error } = await client.auth.signInWithPassword({ email, password });

  submitBtn.disabled = false;
  if (error) {
    errorEl.textContent = error.message;
    return;
  }

  const { data: session } = await client.auth.getSession();
  const { data: profile } = await client
    .from('user_profiles')
    .select('id, full_name')
    .eq('id', session.session.user.id)
    .single();
  if (profile) await logActivity(profile, 'login', `${profile.full_name} logged in`);

  window.location.href = 'pos.html';
}

function renderDemoLogin() {
  const panel = document.getElementById('demo-login');
  panel.hidden = false;
  panel.innerHTML = `
    <p style="font-size: 0.8rem; color: var(--text-muted); margin: 1rem 0 0.5rem;">
      Demo mode: running on sample data. Tap to sign in (Admin uses email and password above):
    </p>
    <div style="display: flex; flex-direction: column; gap: 0.4rem;">
      ${DEMO_ACCOUNTS.filter((acc) => !acc.hiddenFromQuickLogin).map(
        (acc) => `<button type="button" class="ghost demo-account-btn" data-email="${acc.email}">
          ${acc.full_name} — ${roleLabel(acc.role)}
        </button>`
      ).join('')}
    </div>
    <div class="demo-data-actions">
      <button type="button" id="demo-sample" class="ghost" title="Stock at both locations, sample cost prices, customers and three weeks of sales">Load sample data</button>
      <button type="button" id="demo-reset" class="ghost">Reset demo data</button>
    </div>
    <p class="demo-data-note" id="demo-data-note"></p>
  `;

  panel.querySelectorAll('.demo-account-btn').forEach((btn) => {
    btn.addEventListener('click', () => signIn(btn.dataset.email, 'demo'));
  });
  document.getElementById('demo-reset').addEventListener('click', () => {
    if (!confirm('Reset the demo? Everything entered in this browser (sales, products, stock, photos) is cleared.')) return;
    resetDemoData();
    window.location.reload();
  });
  document.getElementById('demo-sample').addEventListener('click', () => {
    if (!confirm('Load sample data? This replaces the demo data in this browser with sample stock, cost prices, customers and three weeks of sales.')) return;
    loadSampleData();
    // Reload so this page's in-memory demo state is the sample too -- otherwise signing in
    // (which logs activity and saves state) would write the old data back over it.
    try {
      sessionStorage.setItem('subtle-pos-demo-note', 'Sample data loaded. Sign in to explore it.');
    } catch {
      // the note is a nicety
    }
    window.location.reload();
  });
  try {
    const note = sessionStorage.getItem('subtle-pos-demo-note');
    if (note) {
      document.getElementById('demo-data-note').textContent = note;
      sessionStorage.removeItem('subtle-pos-demo-note');
    }
  } catch {
    // ignore
  }
}

init();
