import { isDemoMode } from './supabaseClient.js';
import { startHeartbeat } from './activity.js';

// Shared header, rendered into <nav id="app-nav"> on every authenticated page. Role-based
// link visibility here is a UX convenience only -- RLS is what actually enforces access if
// someone navigates to a restricted page or hits the API directly.
//
// Also starts the presence heartbeat (see activity.js) -- since every authenticated page
// calls renderNav(), this is the one place that guarantees last_seen_at gets updated no
// matter which page someone has open, without every page needing its own copy of that
// wiring.
let heartbeatTimer = null;

export function renderNav(profile) {
  const nav = document.getElementById('app-nav');
  if (!nav) return;

  const isManager = profile.role !== 'cashier';

  nav.innerHTML = `
    <div class="nav-brand">Subtle POS ${isDemoMode() ? '<span class="demo-badge">DEMO DATA</span>' : ''}</div>
    <div class="nav-links">
      <a href="pos.html">Checkout</a>
      <a href="stock-take.html">Stock Take</a>
      <a href="returns.html">Returns</a>
      <a href="customers.html">Customers</a>
      ${isManager ? '<a href="inventory.html">Inventory</a><a href="admin.html">Admin</a><a href="purchase-orders.html">Purchase Orders</a><a href="reports.html">Reports</a><a href="activity.html">Activity</a>' : ''}
      ${profile.role === 'admin' ? '<a href="transfers.html">Transfers</a>' : ''}
    </div>
    <div class="nav-user">
      <span>${profile.full_name} · ${profile.role.replace('_', ' ')}</span>
      <button id="nav-signout" type="button">Sign out</button>
    </div>
  `;

  document.getElementById('nav-signout').addEventListener('click', async () => {
    const { signOut } = await import('./auth.js');
    await signOut(profile);
  });

  if (!heartbeatTimer) heartbeatTimer = startHeartbeat(profile);
}
