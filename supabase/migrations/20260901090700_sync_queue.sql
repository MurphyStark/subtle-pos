-- Offline outbox: unsynced sales, stock adjustments, and transfers queue here on the
-- device (IndexedDB mirrors this shape client-side) and replay to Supabase in order once
-- connectivity returns.

create table sync_queue (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in (
    'sale', 'sale_item', 'sale_item_return',
    'stock_count', 'stock_count_item',
    'inventory_transfer', 'inventory_transfer_item'
  )),
  entity_id uuid not null,
  payload jsonb not null,
  status sync_status not null default 'pending',
  error_message text,
  created_by uuid references user_profiles (id), -- whose device queued this, for RLS scoping
  created_at timestamptz not null default now(),
  synced_at timestamptz
);

create index sync_queue_status_idx on sync_queue (status, created_at);
