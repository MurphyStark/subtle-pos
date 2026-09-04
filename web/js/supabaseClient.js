import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Relies on the Supabase UMD bundle (loaded via <script> before this module in every page)
// putting a `supabase` global on window -- no bundler in this project, so ESM imports of
// npm packages aren't available; this is the standard no-build-step pattern for Supabase.
let client = null;

export function getClient() {
  if (!client) {
    if (!window.supabase) {
      throw new Error('Supabase UMD script not loaded -- check the <script> tag order in this page.');
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return client;
}
