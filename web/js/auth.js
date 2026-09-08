import { getClient } from './supabaseClient.js';

// user_profiles is readable for the caller's own row (see the RLS migration), which is all
// this needs: id, role, and primary_location_id drive every access decision in the UI.
export async function getCurrentProfile() {
  const client = getClient();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) return null;

  const { data: profile, error } = await client
    .from('user_profiles')
    .select('id, full_name, role, primary_location_id, manager_pin, last_seen_at')
    .eq('id', session.user.id)
    .single();

  if (error || !profile) return null;
  return { session, profile };
}

// Call at the top of every page (except index.html). Redirects to login if not
// authenticated, or shows an access-restricted message if allowedRoles is given and the
// user's role isn't in it. This is a UX convenience only -- the real enforcement is RLS at
// the database layer (see the RLS migration's header comment).
export async function requireAuth(allowedRoles = null) {
  const result = await getCurrentProfile();
  if (!result) {
    window.location.href = 'index.html';
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(result.profile.role)) {
    document.body.innerHTML = `
      <main class="unauthorized">
        <h1>Access restricted</h1>
        <p>Your role (${result.profile.role.replace('_', ' ')}) doesn't have access to this page.</p>
        <a href="pos.html">Back to checkout</a>
      </main>`;
    return null;
  }
  return result;
}

// profile is optional but should be passed whenever the caller already has it -- logging
// "logout" needs to happen BEFORE the session actually ends (activity_log's RLS requires
// user_id = auth.uid(), which stops being true the instant signOut() completes).
export async function signOut(profile) {
  if (profile) {
    const { logActivity } = await import('./activity.js');
    await logActivity(profile, 'logout', `${profile.full_name} logged out`);
  }
  await getClient().auth.signOut();
  window.location.href = 'index.html';
}
