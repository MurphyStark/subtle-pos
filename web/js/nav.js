import { getClient, isDemoMode } from './supabaseClient.js';
import { startHeartbeat } from './activity.js';
import { icon } from './icons.js';

// The app shell, rendered on every authenticated page: a dark sidebar (grouped links, the
// signed-in user at the bottom) rendered into <nav id="app-nav">, plus the location chip and
// avatar appended to the page's own <header class="page-header">. Role-based link visibility
// here is a UX convenience only -- RLS is what actually enforces access if someone navigates
// to a restricted page or hits the API directly.
//
// Also starts the presence heartbeat (see activity.js) -- since every authenticated page
// calls renderNav(), this is the one place that guarantees last_seen_at gets updated no
// matter which page someone has open, without every page needing its own copy of that
// wiring.
let heartbeatTimer = null;

const ROLE_LABELS = {
  admin: 'Admin',
  owner: 'Shop Owner',
  shop_manager: 'Shop Manager',
  wholesale_manager: 'Wholesale Manager',
  cashier: 'Cashier',
};

const MANAGERS = ['shop_manager', 'wholesale_manager', 'owner', 'admin'];
const EVERYONE = ['cashier', ...MANAGERS];

const NAV_GROUPS = [
  {
    items: [
      { href: 'pos.html', label: 'Checkout', icon: 'cart', roles: EVERYONE },
      { href: 'returns.html', label: 'Returns', icon: 'undo', roles: EVERYONE },
    ],
  },
  {
    title: 'Catalog',
    items: [
      { href: 'admin.html', label: 'Products', icon: 'tag', roles: MANAGERS },
      { href: 'inventory.html', label: 'Inventory', icon: 'layers', roles: MANAGERS },
      { href: 'stock-take.html', label: 'Stock Take', icon: 'clipboard', roles: EVERYONE },
      { href: 'customers.html', label: 'Customers', icon: 'users', roles: EVERYONE },
    ],
  },
  {
    title: 'Operations',
    items: [
      { href: 'purchase-orders.html', label: 'Purchase Orders', icon: 'truck', roles: MANAGERS },
      { href: 'transfers.html', label: 'Transfers', icon: 'transfer', roles: ['admin'] },
    ],
  },
  {
    title: 'Insights',
    items: [
      { href: 'reports.html', label: 'Reports', icon: 'chart', roles: MANAGERS },
      { href: 'activity.html', label: 'Activity', icon: 'clock', roles: MANAGERS },
    ],
  },
];

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? role.replace('_', ' ');
}

export function initials(name) {
  return (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

export function renderNav(profile) {
  const nav = document.getElementById('app-nav');
  if (!nav) return;
  document.body.classList.add('has-shell');

  // Sub-pages light up their parent section.
  const PARENT = { 'product.html': 'admin.html', 'variant.html': 'inventory.html', 'stock-takes.html': 'stock-take.html', 'stock-take-report.html': 'stock-take.html' };
  const page = location.pathname.split('/').pop() || 'pos.html';
  const current = PARENT[page] ?? page;
  const groupsHtml = NAV_GROUPS.map((group) => {
    const links = group.items
      .filter((item) => item.roles.includes(profile.role))
      .map(
        (item) => `
        <a href="${item.href}" class="nav-link${item.href === current ? ' active' : ''}"${item.href === current ? ' aria-current="page"' : ''}>
          ${icon(item.icon)}<span>${item.label}</span>
        </a>`
      )
      .join('');
    if (!links) return '';
    return `<div class="nav-group">${group.title ? `<div class="nav-group-title">${group.title}</div>` : ''}${links}</div>`;
  }).join('');

  nav.innerHTML = `
    <a class="nav-brand" href="pos.html">
      <img src="img/mark.png" alt="" class="nav-brand-mark" />
      <span>
        <span class="nav-brand-name">Subtle POS${isDemoMode() ? ' <span class="demo-badge">Demo</span>' : ''}</span>
        <span class="nav-brand-sub">Subtle Accessories</span>
      </span>
    </a>
    <div class="nav-links">${groupsHtml}</div>
    <div class="nav-user">
      <span class="avatar">${initials(profile.full_name)}</span>
      <span class="nav-user-text">
        <span class="nav-user-name">${profile.full_name}</span>
        <span class="nav-user-role">${roleLabel(profile.role)}</span>
      </span>
      <button id="nav-signout" type="button" class="icon-btn" title="Sign out" aria-label="Sign out">${icon('logout', { size: 18 })}</button>
    </div>
  `;

  document.getElementById('nav-signout').addEventListener('click', async () => {
    const { signOut } = await import('./auth.js');
    await signOut(profile);
  });

  renderTopbarTools(profile);
  wireMobileMenu();

  if (!heartbeatTimer) heartbeatTimer = startHeartbeat(profile);
}

// Location chip + avatar at the right of the page header, and a menu button for small
// screens where the sidebar slides in over the page.
async function renderTopbarTools(profile) {
  const header = document.querySelector('.page-header');
  if (!header || header.querySelector('.topbar-tools')) return;

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'icon-btn menu-toggle';
  menuBtn.setAttribute('aria-label', 'Open menu');
  menuBtn.innerHTML = icon('menu');
  header.prepend(menuBtn);

  const tools = document.createElement('div');
  tools.className = 'topbar-tools';
  tools.innerHTML = `
    <span class="location-chip">${icon('pin', { size: 18 })}<span id="topbar-location">…</span></span>
    <span class="avatar" title="${profile.full_name} · ${roleLabel(profile.role)}">${initials(profile.full_name)}</span>
  `;
  header.append(tools);

  try {
    const { data } = await getClient().from('locations').select('id, name').eq('id', profile.primary_location_id).single();
    document.getElementById('topbar-location').textContent = data?.name ?? 'No location';
  } catch {
    document.getElementById('topbar-location').textContent = 'Offline';
  }
}

function wireMobileMenu() {
  const toggle = document.querySelector('.menu-toggle');
  if (!toggle) return;
  let scrim = document.querySelector('.nav-scrim');
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.className = 'nav-scrim';
    document.body.append(scrim);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('nav-animate')));
  const close = () => document.body.classList.remove('nav-open');
  toggle.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}
