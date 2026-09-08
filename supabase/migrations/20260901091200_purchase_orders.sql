-- STEP 5 of the fashion-retail evolution: purchase orders. The stock-transfer lifecycle
-- these are paired with (transfers.html) needs no new tables -- inventory_transfers /
-- inventory_transfer_items and fn_apply_transfer_receipt already exist from the original
-- schema and were already migrated to variant_id in the product_variants migration.
--
-- "Mark received" against a PO deliberately does NOT duplicate stock/cost logic here: it
-- creates a real stock_receipts/stock_receipt_items row (see inventory_and_receipts.sql),
-- which already recomputes weighted-average cost and drops a product_cost_history row via
-- fn_apply_stock_receipt_item. purchase_order_id on stock_receipts is traceability only.

create type purchase_order_status as enum ('draft', 'sent', 'partially_received', 'received', 'cancelled');

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers (id),
  location_id uuid not null references locations (id), -- destination
  status purchase_order_status not null default 'draft',
  currency text not null default 'USD',
  created_by uuid references user_profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger purchase_orders_set_updated_at
  before update on purchase_orders
  for each row execute function set_updated_at();

create table purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders (id),
  variant_id uuid not null references product_variants (id),
  quantity_ordered integer not null check (quantity_ordered > 0),
  expected_unit_cost_cents bigint not null check (expected_unit_cost_cents >= 0),
  -- Updated by the app as receipts land against this PO (see purchase-orders.js) --
  -- deliberately not DB-trigger-driven, since this is workflow status, not financial
  -- history; the actual stock/cost effects flow through stock_receipt_items as normal.
  quantity_received integer not null default 0 check (quantity_received >= 0),
  created_at timestamptz not null default now()
);

alter table stock_receipts add column purchase_order_id uuid references purchase_orders (id);

alter table purchase_orders enable row level security;
alter table purchase_order_items enable row level security;

create policy purchase_orders_all on purchase_orders for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());
create policy purchase_order_items_all on purchase_order_items for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());
