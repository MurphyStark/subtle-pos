-- Products, and the two append-only history tables that make retroactive cost/price
-- changes safe: product_prices (selling prices) and product_cost_history (unit cost).

create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  barcode text unique,
  name text not null,
  category_id uuid references categories (id),
  base_currency text not null default 'USD',
  -- Minimum wholesale quantity enforcement (below-minimum pricing needs manager approval,
  -- enforced at the application/workflow layer since it's an approval-gate, not a hard rule).
  min_wholesale_qty integer not null default 1 check (min_wholesale_qty > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger products_set_updated_at
  before update on products
  for each row execute function set_updated_at();

-- Append-only: a price change inserts a new effective-dated row, never an update. Retail
-- and wholesale prices carry no cost data, so every role may read this table freely.
create table product_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  price_type price_type not null,
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  currency text not null,
  effective_date timestamptz not null default now(),
  created_by uuid references user_profiles (id),
  created_at timestamptz not null default now()
);

create index product_prices_lookup_idx on product_prices (product_id, price_type, effective_date desc);

create trigger product_prices_no_update
  before update or delete on product_prices
  for each row execute function reject_mutation();

-- Append-only unit-cost timeline. sale_items.unit_cost_at_sale is snapshotted from whatever
-- the most recent row here was at the moment of sale, then frozen -- this table can keep
-- changing after the fact with zero effect on past sales' recorded profit.
create table product_cost_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  supplier_id uuid references suppliers (id),
  unit_cost_cents bigint not null check (unit_cost_cents >= 0),
  currency text not null,
  effective_date timestamptz not null default now(),
  stock_receipt_id uuid, -- FK added in the inventory migration, once stock_receipts exists
  created_at timestamptz not null default now()
);

create index product_cost_history_lookup_idx on product_cost_history (product_id, effective_date desc);

create trigger product_cost_history_no_update
  before update or delete on product_cost_history
  for each row execute function reject_mutation();
