import { getClient } from './supabaseClient.js';
import { getCurrentProfile } from './auth.js';
import { registerServiceWorker } from './pwa.js';

async function init() {
  registerServiceWorker();

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

    if (!navigator.onLine) {
      errorEl.textContent = 'Signing in requires an internet connection the first time on this device.';
      return;
    }

    const email = form.email.value.trim();
    const password = form.password.value;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    const { error } = await getClient().auth.signInWithPassword({ email, password });

    submitBtn.disabled = false;
    if (error) {
      errorEl.textContent = error.message;
      return;
    }
    window.location.href = 'pos.html';
  });
}

init();
