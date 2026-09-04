-- Sales, sale line items (the immutable financial snapshot), and returns/refunds with
-- COGS reversal.

create table sales (
  id uuid primary key default gen_random_uuid(), -- CLIENT-GENERATED UUIDv4, never server auto-increment
  location_id uuid not null references locations (id),
  cashier_id uuid not null references user_profiles (id),
  sale_type sale_type not null default 'retail',
  customer_name text,
  currency text not null,
  exchange_rate_at_sale numeric(18, 8) not null default 1,
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0), -- VAT shown as its own line, never folded into price
  total_cents bigint not null check (total_cents >= 0),
  sync_status sync_status not null default 'pending',
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

create index sales_location_created_idx on sales (location_id, created_at desc);

-- Supports settling one sale across more than one currency/tender (e.g. part USD cash,
-- part local-currency card) -- a near-certain requirement once multi-currency settlement
-- is in play, even though the PRD addendum doesn't spell out a payments table explicitly.
create table sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id),
  method text not null check (method in ('cash', 'card', 'ecocash', 'bank_transfer', 'other')),
  currency text not null,
  amount_cents bigint not null check (amount_cents > 0),
  exchange_rate_at_payment numeric(18, 8) not null default 1,
  created_at timestamptz not null default now()
);

-- THE core invariant (PRD section 1.1): a completed sale is a financial snapshot, never a
-- live reference to the product. unit_selling_price_cents is supplied by the client (a
-- cashier legitimately knows the selling price) from its own locally cached product_prices
-- data at insert time. unit_cost_at_sale_cents is DELIBERATELY NOT client-supplied: a
-- cashier's RLS grants make it impossible for their device to know cost at all (see the RLS
-- migration), so it is populated server-side by fn_populate_sale_item_cost_snapshot below,
-- which runs whenever the row is actually written to Postgres -- whether that's immediately
-- (online) or later (replayed from the offline sync_queue) -- and looks up whatever
-- product_cost_history row was in effect as of the parent sale's own created_at, i.e. the
-- moment the sale actually happened, not the moment it happened to sync. Either way, once
-- written, neither price nor cost can change again.
create table sale_items (
  id uuid primary key default gen_random_uuid(), -- client-generated
  sale_id uuid not null references sales (id),
  product_id uuid not null references products (id),
  quantity integer not null check (quantity > 0),
  unit_selling_price_cents bigint not null check (unit_selling_price_cents >= 0),
  unit_cost_at_sale_cents bigint not null check (unit_cost_at_sale_cents >= 0),
  currency text not null,
  exchange_rate_at_sale numeric(18, 8) not null default 1,
  cost_of_goods_sold_cents bigint generated always as (quantity * unit_cost_at_sale_cents) stored,
  gross_profit_cents bigint generated always as
    (quantity * unit_selling_price_cents - quantity * unit_cost_at_sale_cents) stored,
  created_at timestamptz not null default now()
);

create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_product_idx on sale_items (product_id);

comment on column sale_items.cost_of_goods_sold_cents is
  'GENERATED column: Postgres itself rejects any direct write to this, and it only ever '
  'recomputes from quantity/unit_cost_at_sale_cents -- which are frozen after insert by '
  'sale_items_immutable below. That combination, not the trigger alone, is what makes COGS '
  'and gross profit immutable.';

-- Populates unit_cost_at_sale_cents server-side from product_cost_history, as of the
-- parent sale's created_at. Runs BEFORE the NOT NULL/CHECK constraints are validated, so
-- the client can omit the column (or send anything -- it's overwritten either way). A
-- product with no cost history yet cannot be sold, by design: there is no cost basis to
-- snapshot, so COGS/gross profit could never be computed for it.
create or replace function fn_populate_sale_item_cost_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_created_at timestamptz;
  v_cost bigint;
begin
  select created_at into v_sale_created_at from sales where id = new.sale_id;

  select unit_cost_cents into v_cost
    from product_cost_history
    where product_id = new.product_id and effective_date <= v_sale_created_at
    order by effective_date desc
    limit 1;

  if v_cost is null then
    raise exception 'No product_cost_history exists for product % as of %; cannot record a sale with no cost basis to snapshot.',
      new.product_id, v_sale_created_at;
  end if;

  new.unit_cost_at_sale_cents := v_cost;
  return new;
end;
$$;

create trigger sale_items_populate_cost_snapshot
  before insert on sale_items
  for each row execute function fn_populate_sale_item_cost_snapshot();

-- Reject any edit to the snapshotted price/cost/quantity after the row exists. Corrections
-- happen only via a new linked sale_item_returns row, never an edit to history.
create or replace function fn_reject_sale_item_snapshot_edit()
returns trigger
language plpgsql
as $$
begin
  if new.unit_selling_price_cents is distinct from old.unit_selling_price_cents
     or new.unit_cost_at_sale_cents is distinct from old.unit_cost_at_sale_cents
     or new.quantity is distinct from old.quantity
     or new.currency is distinct from old.currency
     or new.exchange_rate_at_sale is distinct from old.exchange_rate_at_sale then
    raise exception 'sale_items is immutable once written: row % may not be changed. Use sale_item_returns for corrections.',
      old.id;
  end if;
  return new;
end;
$$;

create trigger sale_items_immutable
  before update on sale_items
  for each row execute function fn_reject_sale_item_snapshot_edit();

create trigger sale_items_no_delete
  before delete on sale_items
  for each row execute function reject_mutation();

-- Authoritative stock reconciliation. Runs whenever a sale_items row lands in Postgres --
-- whether inserted directly online or replayed from the offline sync_queue -- so both paths
-- go through identical logic (PRD section 1.2: "the server is the source of truth on
-- reconciliation"). The decrement always applies (the sale already happened); a location
-- that disallows negative stock gets flagged for manager review instead of the sale being
-- blocked or silently allowed to go negative unnoticed.
create or replace function fn_apply_sale_item_inventory_impact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_location_id uuid;
  v_allow_negative boolean;
  v_resulting_qty integer;
  v_found boolean;
begin
  select location_id into v_location_id from sales where id = new.sale_id;
  select negative_stock_enabled into v_allow_negative from locations where id = v_location_id;

  update inventory_balances
    set quantity_available = quantity_available - new.quantity,
        updated_at = now()
    where product_id = new.product_id and location_id = v_location_id
    returning quantity_available into v_resulting_qty;
  v_found := found;

  if not v_found then
    insert into inventory_balances (product_id, location_id, quantity_available, needs_review, needs_review_reason)
    values (
      new.product_id, v_location_id, -new.quantity, true,
      'Sale recorded for a product with no prior inventory_balances row at this location.'
    );
  elsif v_resulting_qty < 0 and not v_allow_negative then
    update inventory_balances
      set needs_review = true,
          needs_review_reason = 'Stock went negative on sale ' || new.sale_id || ' and this location disallows negative stock.'
      where product_id = new.product_id and location_id = v_location_id;
  end if;

  return new;
end;
$$;

create trigger sale_items_apply_inventory_impact
  after insert on sale_items
  for each row execute function fn_apply_sale_item_inventory_impact();

-- Reverses cost_of_goods_sold and gross_profit using the ORIGINAL recorded unit cost, never
-- today's cost (PRD section 1.5), and restocks at the original sale's location unless a
-- restock_location_id is explicitly given (e.g. the item was transferred before returning).
create table sale_item_returns (
  id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references sale_items (id),
  quantity_returned integer not null check (quantity_returned > 0),
  restock_location_id uuid references locations (id), -- defaults to the original sale's location; see trigger below
  reason text,
  refund_amount_cents bigint not null check (refund_amount_cents >= 0),
  cogs_reversed_cents bigint,
  gross_profit_reversed_cents bigint,
  processed_by uuid references user_profiles (id),
  sync_status sync_status not null default 'pending',
  created_at timestamptz not null default now()
);

create or replace function fn_process_sale_item_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item sale_items%rowtype;
  v_sale_location uuid;
  v_already_returned integer;
begin
  select * into v_item from sale_items where id = new.sale_item_id;

  select coalesce(sum(quantity_returned), 0) into v_already_returned
    from sale_item_returns where sale_item_id = new.sale_item_id;

  if v_already_returned + new.quantity_returned > v_item.quantity then
    raise exception 'Cannot return % units of sale_item %: only % of % remain returnable',
      new.quantity_returned, new.sale_item_id, v_item.quantity - v_already_returned, v_item.quantity;
  end if;

  select location_id into v_sale_location from sales where id = v_item.sale_id;

  if new.restock_location_id is null then
    new.restock_location_id := v_sale_location;
  end if;

  -- Reverse using the ORIGINAL recorded unit cost, never today's cost.
  new.cogs_reversed_cents := new.quantity_returned * v_item.unit_cost_at_sale_cents;
  new.gross_profit_reversed_cents :=
    new.quantity_returned * (v_item.unit_selling_price_cents - v_item.unit_cost_at_sale_cents);

  return new;
end;
$$;

create trigger sale_item_returns_before_insert
  before insert on sale_item_returns
  for each row execute function fn_process_sale_item_return();

create or replace function fn_restock_sale_item_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into inventory_balances (product_id, location_id, quantity_available)
  select product_id, new.restock_location_id, new.quantity_returned
  from sale_items where id = new.sale_item_id
  on conflict (product_id, location_id) do update
    set quantity_available = inventory_balances.quantity_available + new.quantity_returned,
        updated_at = now();
  return new;
end;
$$;

create trigger sale_item_returns_after_insert
  after insert on sale_item_returns
  for each row execute function fn_restock_sale_item_return();

create trigger sale_item_returns_no_update
  before update or delete on sale_item_returns
  for each row execute function reject_mutation();
