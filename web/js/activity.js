import { getClient } from './supabaseClient.js';

// Presence + activity logging, shared by every authenticated page.
//
// PRESENCE: a heartbeat, not a realtime channel. heartbeat() updates
// user_profiles.last_seen_at every ~60s while a page is open; "online now" (see
// activity.html) just means "seen within the last couple of minutes". Simpler than
// Supabase Realtime presence, works identically in demo mode, and is precise enough for a
// small shop -- it doesn't need push-the-instant-a-tab-closes accuracy.
//
// ACTIVITY LOG: logActivity() writes one row per significant action (login, logout, sale,
// stock change, edit, refund, etc.) with the acting user and a timestamp. It never throws
// on failure -- a logging hiccup must not block the real action it's describing.
const HEARTBEAT_INTERVAL_MS = 60_000;
const ONLINE_WINDOW_MS = 2 * 60_000; // "online now" = seen within the last 2 minutes

export async function logActivity(profile, action, description, metadata = {}) {
  try {
    const client = getClient();
    await client.from('activity_log').insert({
      id: crypto.randomUUID(),
      user_id: profile.id,
      action,
      description,
      metadata,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('Activity log write failed (non-blocking):', err);
  }
}

async function heartbeatOnce(profile) {
  try {
    const client = getClient();
    // Via touch_my_presence() -- a direct update of user_profiles is owner-only under RLS.
    await client.rpc('touch_my_presence');
  } catch (err) {
    console.warn('Presence heartbeat failed (non-blocking):', err);
  }
}

export function startHeartbeat(profile) {
  heartbeatOnce(profile);
  return setInterval(() => heartbeatOnce(profile), HEARTBEAT_INTERVAL_MS);
}

export function isOnlineNow(lastSeenAt) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_WINDOW_MS;
}
