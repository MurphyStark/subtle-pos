-- Locations, role profiles, suppliers, and effective-dated currency rates.

create table locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  location_type text not null default 'retail'
    check (location_type in ('retail', 'wholesale', 'warehouse')),
  negative_stock_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

comment on column locations.negative_stock_enabled is
  'When false, a real-time online checkout blocks a sale that would oversell at this '
  'location. A sale that was created OFFLINE and already pushed stock negative by the time '
  'it syncs is never rejected or unwound -- it is honored and inventory_balances.needs_review '
  'is flagged instead. See fn_apply_sale_item_inventory_impact.';

insert into locations (name, location_type) values
  ('Subtle Accessories Shop', 'retail'),
  ('Home / Wholesale Store', 'wholesale');

-- One row per Supabase auth user; RLS policies key off this row's role, not the JWT alone,
-- so role changes take effect without re-issuing tokens.
create table user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  role user_role not null,
  primary_location_id uuid references locations (id),
  created_at timestamptz not null default now()
);

-- SECURITY DEFINER: lets RLS policies elsewhere call this without recursing back into
-- user_profiles' own RLS policy (which would otherwise need to call this to evaluate itself).
create or replace function current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from user_profiles where id = auth.uid();
$$;

create or replace function is_manager_or_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select current_user_role() in ('shop_manager', 'wholesale_manager', 'owner');
$$;

create or replace function is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select current_user_role() = 'owner';
$$;

grant execute on function current_user_role() to authenticated;
grant execute on function is_manager_or_owner() to authenticated;
grant execute on function is_owner() to authenticated;

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_info jsonb not null default '{}'::jsonb,
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

-- Append-only: never update a historical rate in place, insert a new effective-dated row.
-- ASSUMPTION: base currency is USD (the common anchor/settlement currency in this market).
-- rate_to_base = how many minor units of USD one minor unit of currency_code was worth on
-- effective_date. Revisit if Subtle's actual settlement/base currency differs.
create table currency_rates (
  id uuid primary key default gen_random_uuid(),
  currency_code text not null,
  rate_to_base numeric(18, 8) not null check (rate_to_base > 0),
  effective_date date not null,
  created_at timestamptz not null default now(),
  unique (currency_code, effective_date)
);

create or replace function reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: % is not permitted -- insert a new row instead',
    tg_table_name, tg_op;
end;
$$;

create trigger currency_rates_no_update
  before update or delete on currency_rates
  for each row execute function reject_mutation();
