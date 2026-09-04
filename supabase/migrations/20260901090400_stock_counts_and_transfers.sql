-- Physical stock counts (for variance detection) and inter-location transfers.

create table stock_counts (
  id uuid primary key default gen_random_uuid(), -- client-generated
  location_id uuid not null references locations (id),
  status text not null default 'draft' check (status in ('draft', 'completed')),
  counted_by uuid references user_profiles (id),
  sync_status sync_status not null default 'pending',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table stock_count_items (
  id uuid primary key default gen_random_uuid(),
  stock_count_id uuid not null references stock_counts (id),
  product_id uuid not null references products (id),
  counted_quantity integer not null check (counted_quantity >= 0),
  system_quantity_at_count integer not null,
  variance integer generated always as (counted_quantity - system_quantity_at_count) stored,
  created_at timestamptz not null default now()
);

-- Draft -> Requested -> Approved -> In Transit -> Partially Received / Received -> (or
-- Cancelled). A transfer only moves the location of inventory -- it is never a sale or an
-- expense, and never touches cost_of_goods_sold or gross_profit.
create table inventory_transfers (
  id uuid primary key default gen_random_uuid(), -- client-generated
  from_location_id uuid not null references locations (id),
  to_location_id uuid not null references locations (id) check (to_location_id <> from_location_id),
  status transfer_status not null default 'draft',
  requested_by uuid references user_profiles (id),
  approved_by uuid references user_profiles (id),
  sync_status sync_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table inventory_transfer_items (
  id uuid primary key default gen_random_uuid(),
  inventory_transfer_id uuid not null references inventory_transfers (id),
  product_id uuid not null references products (id),
  quantity_requested integer not null check (quantity_requested > 0),
  quantity_sent integer check (quantity_sent >= 0),
  quantity_received integer check (quantity_received >= 0),
  -- Snapshot of the SOURCE location's weighted-average cost at transfer time, so the
  -- destination's average_unit_cost_cents stays correct after the transfer lands.
  unit_cost_at_transfer_cents bigint,
  created_at timestamptz not null default now()
);

-- Moves stock (and its weighted-average cost) between locations once a transfer reaches
-- Received or Partially Received. Deducts from the source location unconditionally: by the
-- time a transfer is Approved/In Transit, the stock has already physically left the source,
-- so the balance follows reality rather than blocking on a guard.
create or replace function fn_apply_transfer_receipt(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_to uuid;
  r record;
begin
  select from_location_id, to_location_id into v_from, v_to
    from inventory_transfers where id = p_transfer_id;

  for r in
    select product_id, coalesce(quantity_received, 0) as qty, coalesce(unit_cost_at_transfer_cents, 0) as unit_cost
    from inventory_transfer_items
    where inventory_transfer_id = p_transfer_id and coalesce(quantity_received, 0) > 0
  loop
    update inventory_balances
      set quantity_available = quantity_available - r.qty, updated_at = now()
      where product_id = r.product_id and location_id = v_from;

    insert into inventory_balances (product_id, location_id, quantity_available, average_unit_cost_cents)
    values (r.product_id, v_to, r.qty, r.unit_cost)
    on conflict (product_id, location_id) do update
      set quantity_available = inventory_balances.quantity_available + excluded.quantity_available,
          average_unit_cost_cents = case
            when inventory_balances.quantity_available + excluded.quantity_available = 0 then 0
            else (inventory_balances.quantity_available * inventory_balances.average_unit_cost_cents
                  + excluded.quantity_available * excluded.average_unit_cost_cents)
                 / (inventory_balances.quantity_available + excluded.quantity_available)
          end,
          updated_at = now();
  end loop;
end;
$$;

create or replace function fn_transfer_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('received', 'partially_received')
     and old.status is distinct from new.status then
    perform fn_apply_transfer_receipt(new.id);
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger inventory_transfers_status_change
  before update on inventory_transfers
  for each row execute function fn_transfer_status_change();
