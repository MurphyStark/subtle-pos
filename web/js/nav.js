// Shared header, rendered into <nav id="app-nav"> on every authenticated page. Role-based
// link visibility here is a UX convenience only -- RLS is what actually enforces access if
// someone navigates to a restricted page or hits the API directly.
export function renderNav(profile) {
  const nav = document.getElementById('app-nav');
  if (!nav) return;

  const isManager = profile.role !== 'cashier';

  nav.innerHTML = `
    <div class="nav-brand">Subtle POS</div>
    <div class="nav-links">
      <a href="pos.html">Checkout</a>
      ${isManager ? '<a href="inventory.html">Inventory</a>' : ''}
    </div>
    <div class="nav-user">
      <span>${profile.full_name} · ${profile.role.replace('_', ' ')}</span>
      <button id="nav-signout" type="button">Sign out</button>
    </div>
  `;

  document.getElementById('nav-signout').addEventListener('click', async () => {
    const { signOut } = await import('./auth.js');
    await signOut();
  });
}
