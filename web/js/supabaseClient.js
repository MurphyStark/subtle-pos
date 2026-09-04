import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createMockClient } from './mockClient.js';

// Relies on the Supabase UMD bundle (loaded via <script> before this module in every page)
// putting a `supabase` global on window -- no bundler in this project, so ESM imports of
// npm packages aren't available; this is the standard no-build-step pattern for Supabase.
let client = null;

// True until config.js has real values in it. Drives the automatic demo-mode fallback
// below -- there is no separate flag to remember to flip. See mockClient.js.
export function isDemoMode() {
  return !SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT-REF');
}

export function getClient() {
  if (!client) {
    if (isDemoMode()) {
      console.info('[Subtle POS] No Supabase project configured yet -- running in demo mode on sample data (see js/mockClient.js).');
      client = createMockClient();
      return client;
    }
    if (!window.supabase) {
      throw new Error('Supabase UMD script not loaded -- check the <script> tag order in this page.');
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}
