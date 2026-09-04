import { getClient, isDemoMode } from './supabaseClient.js';
import { getCurrentProfile } from './auth.js';
import { registerServiceWorker } from './pwa.js';
import { DEMO_ACCOUNTS, resetDemoData } from './mockClient.js';

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

  const { error } = await getClient().auth.signInWithPassword({ email, password });

  submitBtn.disabled = false;
  if (error) {
    errorEl.textContent = error.message;
    return;
  }
  window.location.href = 'pos.html';
}

function renderDemoLogin() {
  const panel = document.getElementById('demo-login');
  panel.hidden = false;
  panel.innerHTML = `
    <p style="font-size: 0.8rem; color: var(--text-muted); margin: 1rem 0 0.5rem;">
      No Supabase project connected yet — running on sample data. Sign in as:
    </p>
    <div style="display: flex; flex-direction: column; gap: 0.4rem;">
      ${DEMO_ACCOUNTS.map(
        (acc) => `<button type="button" class="ghost demo-account-btn" data-email="${acc.email}">
          ${acc.full_name} — ${acc.role.replace('_', ' ')}
        </button>`
      ).join('')}
    </div>
    <button type="button" id="demo-reset" class="ghost" style="width: 100%; margin-top: 0.6rem; font-size: 0.8rem;">
      Reset demo data
    </button>
  `;

  panel.querySelectorAll('.demo-account-btn').forEach((btn) => {
    btn.addEventListener('click', () => signIn(btn.dataset.email, 'demo'));
  });
  document.getElementById('demo-reset').addEventListener('click', () => {
    resetDemoData();
    window.location.reload();
  });
}

init();
