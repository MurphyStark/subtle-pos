-- Subtle POS schema
--
-- ASSUMPTION / GAP: the original PRD's full Section 18 table list was not available when
-- this migration set was written (only the "PRD v2" addendum, which describes the business
-- logic in prose but doesn't reproduce Section 18's literal field list). This schema was
-- reconstructed from that addendum plus the VS Code build prompt plus standard POS domain
-- modeling. Diff it against the source PRD's Section 18 for exact field-name parity before
-- treating it as final, and flag anything that doesn't match so it can be corrected here.

create extension if not exists pgcrypto; -- gen_random_uuid()

-- PRD section 19
create type user_role as enum ('cashier', 'shop_manager', 'wholesale_manager', 'owner');

-- PRD section 1.2 offline-first sync lifecycle
create type sync_status as enum ('pending', 'synced', 'conflict');

-- Stock transfer lifecycle (Part 2 core business logic)
create type transfer_status as enum (
  'draft', 'requested', 'approved', 'in_transit',
  'partially_received', 'received', 'cancelled'
);

-- PRD section 1.6
create type expense_category as enum (
  'direct_cost', 'operating_expense', 'capex',
  'owner_withdrawal', 'stock_purchase', 'other'
);

create type price_type as enum ('retail', 'wholesale');
create type sale_type as enum ('retail', 'wholesale');

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
