-- STEP 1 of the fashion-retail evolution: introduce product_variants (size/color/SKU/
-- barcode/per-location stock), moving those off products onto the new table, with a
-- zero-data-loss backfill of every existing product into a single default variant.
--
-- DESIGN DECISION (flagged for review): retail/wholesale PRICE (product_prices) and COST
-- (product_cost_history) stay at the PRODUCT level, shared across all of a product's
-- variants -- only identity (SKU/barcode) and physical stock move to the variant level.
-- This matches how the admin flow is being specced (price/cost entered once on the parent
-- product; size/color/barcode/initial-qty entered per variant) and how most boutique
-- apparel actually prices (a shirt costs the same regardless of size). If per-variant cost
-- or pricing ever turns out to be needed (e.g. different landed cost per size), that's an
-- additive change later -- nothing here forecloses it.
--
-- Everything that tracks or moves physical stock now references variant_id instead of
-- product_id: inventory_balances, sale_items, stock_receipt_items, stock_count_items,
-- inventory_transfer_items. product_cost_history is intentionally UNCHANGED (still
-- product_id-keyed) per the decision above.

-- ---------------------------------------------------------------------------------------
-- Drop the two views that expose product_id -- they depend on that column, so it can't be
-- dropped out from under sale_items/inventory_balances until these are gone. Recreated
-- with variant_id at the end of this migration.
-- ---------------------------------------------------------------------------------------
drop view if exists v_sale_items;
drop view if exists v_inventory_balances;

-- ---------------------------------------------------------------------------------------
-- product_variants
-- ---------------------------------------------------------------------------------------
create table product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  size text,
  color text,
  sku text not null unique,
  barcode text unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- NULL size/color both mean "this dimension doesn't apply to this product" (e.g. a
-- product with no size variation at all) -- a functional index with coalesce() is used
-- instead of a plain UNIQUE(product_id, size, color) because Postgres treats every NULL as
-- distinct from every other NULL in a plain unique constraint, which would silently allow
-- duplicate "no size / no color" variants on the same product.
create unique index product_variants_unique_combo
  on product_variants (product_id, coalesce(size, ''), coalesce(color, ''));

create index product_variants_product_idx on product_variants (product_id);

create trigger product_variants_set_updated_at
  before update on product_variants
  for each row execute function set_updated_at();

alter table product_variants enable row level security;

create policy product_variants_select on product_variants for select to authenticated using (true);
create policy product_variants_write on product_variants for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

-- Zero-data-loss backfill: every existing product becomes a product with exactly one
-- default variant (size/color both null) carrying that product's old sku/barcode forward.
insert into product_variants (product_id, size, color, sku, barcode, is_active, created_at)
select id, null, null, sku, barcode, is_active, created_at
from products;

-- ---------------------------------------------------------------------------------------
-- inventory_balances: product_id -> variant_id
-- ---------------------------------------------------------------------------------------
alter table inventory_balances add column variant_id uuid references product_variants (id);

update inventory_balances ib
set variant_id = pv.id
from product_variants pv
where pv.product_id = ib.product_id; -- exactly one variant per product at this point in the migration

alter table inventory_balances alter column variant_id set not null;
-- Dropping product_id cascades to drop the old unique(product_id, location_id) constraint
-- automatically (it depends solely on this column) -- no need to name-guess it explicitly.
alter table inventory_balances drop column product_id;
alter table inventory_balances add constraint inventory_balances_variant_id_location_id_key unique (variant_id, location_id);

-- ---------------------------------------------------------------------------------------
-- sale_items: product_id -> variant_id (a sale line is for a specific variant; this
-- passes the immutability trigger untouched -- it only guards
-- unit_selling_price_cents/unit_cost_at_sale_cents/quantity/currency/exchange_rate_at_sale,
-- never product_id/variant_id)
-- ---------------------------------------------------------------------------------------
alter table sale_items add column variant_id uuid references product_variants (id);

update sale_items si
set variant_id = pv.id
from product_variants pv
where pv.product_id = si.product_id;

alter table sale_items alter column variant_id set not null;
alter table sale_items drop column product_id;

create index sale_items_variant_idx on sale_items (variant_id);

-- ---------------------------------------------------------------------------------------
-- stock_receipt_items: product_id -> variant_id
-- ---------------------------------------------------------------------------------------
alter table stock_receipt_items add column variant_id uuid references product_variants (id);

update stock_receipt_items sri
set variant_id = pv.id
from product_variants pv
where pv.product_id = sri.product_id;

alter table stock_receipt_items alter column variant_id set not null;
alter table stock_receipt_items drop column product_id;

-- ---------------------------------------------------------------------------------------
-- stock_count_items: product_id -> variant_id
-- ---------------------------------------------------------------------------------------
alter table stock_count_items add column variant_id uuid references product_variants (id);

update stock_count_items sci
set variant_id = pv.id
from product_variants pv
where pv.product_id = sci.product_id;

alter table stock_count_items alter column variant_id set not null;
alter table stock_count_items drop column product_id;

-- ---------------------------------------------------------------------------------------
-- inventory_transfer_items: product_id -> variant_id
-- ---------------------------------------------------------------------------------------
alter table inventory_transfer_items add column variant_id uuid references product_variants (id);

update inventory_transfer_items iti
set variant_id = pv.id
from product_variants pv
where pv.product_id = iti.product_id;

alter table inventory_transfer_items alter column variant_id set not null;
alter table inventory_transfer_items drop column product_id;

-- ---------------------------------------------------------------------------------------
-- products: sku/barcode now live on product_variants only
-- ---------------------------------------------------------------------------------------
alter table products drop column sku;
alter table products drop column barcode;

-- ---------------------------------------------------------------------------------------
-- Trigger functions: every reference to product_id on the five tables above becomes
-- variant_id. product_cost_history stays product_id-keyed by design (see header comment),
-- so anywhere a function needs a product_id for a cost lookup, it resolves it via
-- product_variants first.
-- ---------------------------------------------------------------------------------------

-- NOTE for whoever wires this up via an RPC call: the first parameter is renamed from
-- p_product_id to p_variant_id. CREATE OR REPLACE accepts this fine (parameter names
-- aren't part of a function's identity), but a caller using Supabase's named-argument RPC
-- style (supabase.rpc('check_and_decrement_stock', { p_product_id: ... })) would break --
-- this function isn't called from anywhere in web/js/ yet, so nothing breaks today.
create or replace function check_and_decrement_stock(
  p_variant_id uuid, p_location_id uuid, p_qty integer
) returns boolean
language sql
security definer
set search_path = public
as $$
  with updated as (
    update inventory_balances
    set quantity_available = quantity_available - p_qty,
        updated_at = now()
    where variant_id = p_variant_id
      and location_id = p_location_id
      and (
        quantity_available >= p_qty
        or (select negative_stock_enabled from locations where id = p_location_id)
      )
    returning 1
  )
  select exists (select 1 from updated);
$$;

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
  v_product_id uuid;
  v_existing_qty integer;
  v_existing_avg bigint;
  v_new_avg bigint;
begin
  select location_id, supplier_id, currency
    into v_location_id, v_supplier_id, v_currency
    from stock_receipts where id = new.stock_receipt_id;

  select product_id into v_product_id from product_variants where id = new.variant_id;

  insert into inventory_balances (variant_id, location_id, quantity_available, average_unit_cost_cents, currency)
  values (new.variant_id, v_location_id, 0, 0, v_currency)
  on conflict (variant_id, location_id) do nothing;

  select quantity_available, average_unit_cost_cents
    into v_existing_qty, v_existing_avg
    from inventory_balances
    where variant_id = new.variant_id and location_id = v_location_id
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
  where variant_id = new.variant_id and location_id = v_location_id;

  insert into product_cost_history (product_id, supplier_id, unit_cost_cents, currency, effective_date, stock_receipt_id)
  values (v_product_id, v_supplier_id, new.unit_landed_cost_cents, v_currency, now(), new.stock_receipt_id);

  return new;
end;
$$;

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
    select variant_id, coalesce(quantity_received, 0) as qty, coalesce(unit_cost_at_transfer_cents, 0) as unit_cost
    from inventory_transfer_items
    where inventory_transfer_id = p_transfer_id and coalesce(quantity_received, 0) > 0
  loop
    update inventory_balances
      set quantity_available = quantity_available - r.qty, updated_at = now()
      where variant_id = r.variant_id and location_id = v_from;

    insert into inventory_balances (variant_id, location_id, quantity_available, average_unit_cost_cents)
    values (r.variant_id, v_to, r.qty, r.unit_cost)
    on conflict (variant_id, location_id) do update
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
    where variant_id = new.variant_id and location_id = v_location_id
    returning quantity_available into v_resulting_qty;
  v_found := found;

  if not v_found then
    insert into inventory_balances (variant_id, location_id, quantity_available, needs_review, needs_review_reason)
    values (
      new.variant_id, v_location_id, -new.quantity, true,
      'Sale recorded for a variant with no prior inventory_balances row at this location.'
    );
  elsif v_resulting_qty < 0 and not v_allow_negative then
    update inventory_balances
      set needs_review = true,
          needs_review_reason = 'Stock went negative on sale ' || new.sale_id || ' and this location disallows negative stock.'
      where variant_id = new.variant_id and location_id = v_location_id;
  end if;

  return new;
end;
$$;

create or replace function fn_populate_sale_item_cost_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_created_at timestamptz;
  v_product_id uuid;
  v_cost bigint;
begin
  select created_at into v_sale_created_at from sales where id = new.sale_id;
  select product_id into v_product_id from product_variants where id = new.variant_id;

  select unit_cost_cents into v_cost
    from product_cost_history
    where product_id = v_product_id and effective_date <= v_sale_created_at
    order by effective_date desc
    limit 1;

  if v_cost is null then
    raise exception 'No product_cost_history exists for product % (variant %) as of %; cannot record a sale with no cost basis to snapshot.',
      v_product_id, new.variant_id, v_sale_created_at;
  end if;

  new.unit_cost_at_sale_cents := v_cost;
  return new;
end;
$$;

create or replace function fn_restock_sale_item_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into inventory_balances (variant_id, location_id, quantity_available)
  select variant_id, new.restock_location_id, new.quantity_returned
  from sale_items where id = new.sale_item_id
  on conflict (variant_id, location_id) do update
    set quantity_available = inventory_balances.quantity_available + new.quantity_returned,
        updated_at = now();
  return new;
end;
$$;

create or replace function fn_apply_stock_count_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select variant_id, counted_quantity
    from stock_count_items
    where stock_count_id = new.id
  loop
    insert into inventory_balances (variant_id, location_id, quantity_available)
    values (r.variant_id, new.location_id, r.counted_quantity)
    on conflict (variant_id, location_id) do update
      set quantity_available = r.counted_quantity,
          needs_review = false,
          needs_review_reason = null,
          updated_at = now();
  end loop;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Recreate the two masking views with variant_id in place of product_id.
-- ---------------------------------------------------------------------------------------
create view v_sale_items as
  select
    si.id, si.sale_id, si.variant_id, si.quantity, si.unit_selling_price_cents, si.currency,
    si.exchange_rate_at_sale, si.created_at,
    case when is_manager_or_owner() then si.unit_cost_at_sale_cents end as unit_cost_at_sale_cents,
    case when is_manager_or_owner() then si.cost_of_goods_sold_cents end as cost_of_goods_sold_cents,
    case when is_manager_or_owner() then si.gross_profit_cents end as gross_profit_cents
  from sale_items si
  join sales s on s.id = si.sale_id
  where is_manager_or_owner()
     or s.location_id = (select primary_location_id from user_profiles where id = auth.uid());

create view v_inventory_balances as
  select
    id, variant_id, location_id, quantity_available, currency, needs_review, updated_at,
    case when is_manager_or_owner() then average_unit_cost_cents end as average_unit_cost_cents
  from inventory_balances;

grant select on v_sale_items to authenticated;
grant select on v_inventory_balances to authenticated;
