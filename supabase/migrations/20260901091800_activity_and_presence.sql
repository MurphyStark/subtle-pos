-- Presence ("who's online now") and a full activity log (logins, logouts, sales, stock
-- changes, edits, refunds, and other significant actions), each with the acting user and a
-- timestamp.
--
-- PRESENCE DESIGN: a heartbeat, not Supabase Realtime presence channels. Every
-- authenticated page updates user_profiles.last_seen_at every ~60s while open (see
-- js/activity.js); "online now" is simply "seen within the last couple of minutes". This
-- is simpler than a realtime channel, works identically in demo mode, and is precise
-- enough for a small shop -- it doesn't need push-the-instant-someone-closes-a-tab
-- accuracy.
alter table user_profiles add column last_seen_at timestamptz;

create table activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references user_profiles (id),
  action text not null, -- 'login', 'logout', 'sale', 'stock_change', 'product_created', 'price_updated', 'return_processed', etc. -- free text, not an enum, so new action types never need a migration
  description text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_log_created_at_idx on activity_log (created_at desc);
create index activity_log_user_id_idx on activity_log (user_id);

alter table activity_log enable row level security;

-- Anyone can log their OWN actions (the app does this automatically -- see logActivity in
-- js/activity.js); only managers/owner can read the log back, same trust level as the
-- profitability/reporting pages.
create policy activity_log_insert on activity_log for insert to authenticated
  with check (user_id = auth.uid());
create policy activity_log_select on activity_log for select to authenticated
  using (is_manager_or_owner());

-- Append-only: an audit trail that could be edited after the fact isn't an audit trail.
create trigger activity_log_no_update
  before update or delete on activity_log
  for each row execute function reject_mutation();
