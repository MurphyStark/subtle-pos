import { requireAuth } from './auth.js';
import { getClient } from './supabaseClient.js';
import { renderNav } from './nav.js';
import { registerServiceWorker } from './pwa.js';
import { isOnlineNow } from './activity.js';

// Presence + activity log requirement: "show which staff members are currently online...
// together with a detailed activity log/history showing logins, logouts, sales, stock
// changes, edits, refunds, and other important actions, including the user responsible and
// the date and time of each action."
//
// Manager/owner only -- RLS on activity_log restricts SELECT to is_manager_or_owner() (see
// the activity_and_presence migration), and there's no reason a cashier needs to see
// everyone's login history anyway.
//
// Presence itself is heartbeat-based (see activity.js's startHeartbeat, called from
// nav.js on every page), not a live socket -- "online" means "seen within the last two
// minutes", refreshed here on a short timer so the badge doesn't go stale while this page
// sits open.
let allLog = [];
let userProfiles = [];

async function init() {
  registerServiceWorker();

  const auth = await requireAuth(['shop_manager', 'wholesale_manager', 'owner']);
  if (!auth) return;
  renderNav(auth.profile);

  const client = getClient();
  const [{ data: profiles }, { data: log }] = await Promise.all([
    client.from('user_profiles').select('id, full_name, role, last_seen_at'),
    client.from('activity_log').select('*').order('created_at', { ascending: false }),
  ]);
  userProfiles = profiles ?? [];
  allLog = log ?? [];

  const userNameById = Object.fromEntries(userProfiles.map((u) => [u.id, u.full_name]));
  const actions = [...new Set(allLog.map((l) => l.action))].sort();

  document.getElementById('filter-user').innerHTML +=
    userProfiles.map((u) => `<option value="${u.id}">${u.full_name}</option>`).join('');
  document.getElementById('filter-action').innerHTML +=
    actions.map((a) => `<option value="${a}">${a.replace(/_/g, ' ')}</option>`).join('');

  ['filter-user', 'filter-action', 'filter-from', 'filter-to'].forEach((id) =>
    document.getElementById(id).addEventListener('input', () => renderLog(userNameById))
  );

  renderPresence();
  renderLog(userNameById);

  // Re-render presence every 30s so a badge flips to "offline" without needing a reload --
  // cheap to redo since it's a pure function of already-fetched last_seen_at values.
  setInterval(renderPresence, 30_000);
}

function renderPresence() {
  const container = document.getElementById('presence-list');
  const sorted = userProfiles.slice().sort((a, b) => a.full_name.localeCompare(b.full_name));
  container.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last seen</th></tr></thead>
      <tbody>
        ${sorted
          .map((u) => {
            const online = isOnlineNow(u.last_seen_at);
            return `
          <tr>
            <td>${u.full_name}</td>
            <td>${u.role.replace('_', ' ')}</td>
            <td>${online ? '🟢 Online' : '⚪ Offline'}</td>
            <td>${u.last_seen_at ? new Date(u.last_seen_at).toLocaleString() : 'Never'}</td>
          </tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
}

function renderLog(userNameById) {
  const userId = document.getElementById('filter-user').value;
  const action = document.getElementById('filter-action').value;
  const fromVal = document.getElementById('filter-from').value;
  const toVal = document.getElementById('filter-to').value;
  const from = fromVal ? new Date(`${fromVal}T00:00:00`) : null;
  const to = toVal ? new Date(`${toVal}T23:59:59.999`) : null;

  const filtered = allLog.filter((l) => {
    if (userId && l.user_id !== userId) return false;
    if (action && l.action !== action) return false;
    const t = new Date(l.created_at);
    if (from && t < from) return false;
    if (to && t > to) return false;
    return true;
  });

  const container = document.getElementById('activity-table');
  container.innerHTML = `
    <table>
      <thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>
        ${
          filtered
            .map(
              (l) => `
          <tr>
            <td>${new Date(l.created_at).toLocaleString()}</td>
            <td>${userNameById[l.user_id] ?? 'Unknown'}</td>
            <td>${l.action.replace(/_/g, ' ')}</td>
            <td>${l.description ?? ''}</td>
          </tr>`
            )
            .join('') || '<tr><td colspan="4">No matching activity.</td></tr>'
        }
      </tbody>
    </table>`;
}

init();
