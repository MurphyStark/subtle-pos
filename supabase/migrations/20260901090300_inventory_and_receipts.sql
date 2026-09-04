-- Per-location inventory balances, atomic stock decrement, and stock receipts (landed
-- cost + weighted-average costing).

create table inventory_balances (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  location_id uuid not null references locations (id),
  quantity_available integer not null default 0,
  average_unit_cost_cents bigint not null default 0,
  currency text not null default 'USD',
  needs_review boolean not null default false,
  needs_review_reason text,
  updated_at timestamptz not null default now(),
  unique (product_id, location_id)
);

-- Guarded, atomic decrement for a REAL-TIME ONLINE checkout attempt: call this before
-- inserting the sale so a genuinely out-of-stock cart fails fast, instead of a
-- read-then-write race between two cashiers selling the last unit. Returns true if the
-- decrement applied, false if the stock guard blocked it.
--
-- This is NOT used for offline-sync reconciliation. When a sale was created offline, the
-- sale already happened in the real world by the time it reaches Postgres, so it cannot be
-- rejected here -- see fn_apply_sale_item_inventory_impact, the unconditional, authoritative
-- adjustment that runs for every sale_items row regardless of how it arrived.
create or replace function check_and_decrement_stock(
  p_product_id uuid, p_location_id uuid, p_qty integer
) returns boolean
language sql
security definer
set search_path = public
as $$
  with updated as (
    update inventory_balances
    set quantity_available = quantity_available - p_qty,
        updated_at = now()
    where product_id = p_product_id
      and location_id = p_location_id
      and (
        quantity_available >= p_qty
        or (select negative_stock_enabled from locations where id = p_location_id)
      )
    returning 1
  )
  select exists (select 1 from updated);
$$;

grant execute on function check_and_decrement_stock(uuid, uuid, integer) to authenticated;

create table stock_receipts (
  id uuid primary key default gen_random_uuid(), -- client-generated when created offline
  supplier_id uuid not null references suppliers (id),
  location_id uuid not null references locations (id),
  purchase_cost_cents bigint not null default 0 check (purchase_cost_cents >= 0),
  freight_cents bigint not null default 0 check (freight_cents >= 0),
  customs_cents bigint not null default 0 check (customs_cents >= 0),
  transport_cents bigint not null default 0 check (transport_cents >= 0),
  other_costs_cents bigint not null default 0 check (other_costs_cents >= 0),
  currency text not null,
  received_at timestamptz not null default now(),
  created_by uuid references user_profiles (id),
  sync_status sync_status not null default 'synced',
  created_at timestamptz not null default now()
);

alter table product_cost_history
  add constraint product_cost_history_stock_receipt_id_fkey
  foreign key (stock_receipt_id) references stock_receipts (id);

-- Landed cost per unit (purchase + freight + customs + transport + other, allocated pro
-- rata across the receipt's lines) is computed by the application and stored here as the
-- historical per-unit cost for this specific receipt line.
create table stock_receipt_items (
  id uuid primary key default gen_random_uuid(),
  stock_receipt_id uuid not null references stock_receipts (id),
  product_id uuid not null references products (id),
  quantity integer not null check (quantity > 0),
  unit_landed_cost_cents bigint not null check (unit_landed_cost_cents >= 0),
  created_at timestamptz not null default now()
);

-- Judgment call: treated as append-only like the other cost-bearing tables. A bad receipt
-- line is corrected with a new offsetting receipt, never an edit, so average_unit_cost_cents
-- can never be silently recomputed out from under past sales.
create trigger stock_receipt_items_no_update
  before update or delete on stock_receipt_items
  for each row execute function reject_mutation();

-- On every stock receipt line: bump on-hand quantity, recompute this location's weighted
-- average unit cost, and drop a product_cost_history row so future sales snapshot the cost
-- that was actually in effect (never a cost recomputed after the fact).
create or replace function fn_apply_stock_receipt_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id uuid;
  v_supplier_id uuid;
  v_currency text;
  v_existing_qty integer;
  v_existing_avg bigint;
  v_new_avg bigint;
begin
  select location_id, supplier_id, currency
    into v_location_id, v_supplier_id, v_currency
    from stock_receipts where id = new.stock_receipt_id;

  insert into inventory_balances (product_id, location_id, quantity_available, average_unit_cost_cents, currency)
  values (new.product_id, v_location_id, 0, 0, v_currency)
  on conflict (product_id, location_id) do nothing;

  select quantity_available, average_unit_cost_cents
    into v_existing_qty, v_existing_avg
    from inventory_balances
    where product_id = new.product_id and location_id = v_location_id
    for update;

  v_new_avg := case
    when v_existing_qty + new.quantity = 0 then 0
    else ((v_existing_qty * v_existing_avg) + (new.quantity * new.unit_landed_cost_cents))
         / (v_existing_qty + new.quantity)
  end;

  update inventory_balances
  set quantity_available = v_existing_qty + new.quantity,
      average_unit_cost_cents = v_new_avg,
      updated_at = now()
  where product_id = new.product_id and location_id = v_location_id;

  insert into product_cost_history (product_id, supplier_id, unit_cost_cents, currency, effective_date, stock_receipt_id)
  values (new.product_id, v_supplier_id, new.unit_landed_cost_cents, v_currency, now(), new.stock_receipt_id);

  return new;
end;
$$;

create trigger stock_receipt_items_apply
  after insert on stock_receipt_items
  for each row execute function fn_apply_stock_receipt_item();
