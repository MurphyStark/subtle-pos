-- Verifies the core invariant (PRD section 1.1 / build prompt): changing a product's cost
-- later must NOT change the profit already recorded on a completed sale, and a direct edit
-- to a sale_items snapshot column must be rejected.
--
-- Run with:  psql "$DATABASE_URL" -f supabase/tests/immutability_test.sql
--
-- Everything runs inside a transaction that is rolled back at the end, so no test data is
-- left behind and cleanup never has to fight the append-only / immutability triggers.

begin;

do $$
declare
  v_owner_id uuid := gen_random_uuid();
  v_location_id uuid;
  v_product_id uuid := gen_random_uuid();
  v_variant_id uuid := gen_random_uuid();
  v_sale_id uuid := gen_random_uuid();
  v_sale_item_id uuid := gen_random_uuid();
  v_profit_before bigint;
  v_profit_after bigint;
  v_update_rejected boolean := false;
  -- now()/CURRENT_TIMESTAMP is FROZEN for the whole transaction in Postgres, and this
  -- entire test runs inside one begin/rollback block -- so relying on each row's
  -- effective_date/created_at DEFAULT of now() would give every row the exact same
  -- timestamp, making the trigger's "as of the sale's time" lookup order ambiguous
  -- instead of actually testing it. Explicit, deliberately-ordered timestamps instead.
  v_cost_before_sale timestamptz := now() - interval '10 days';
  v_sale_time timestamptz := now() - interval '5 days';
  v_cost_after_sale timestamptz := now();
begin
  select id into v_location_id from locations limit 1;

  insert into auth.users (id, email) values (v_owner_id, 'test-owner@example.invalid');
  insert into user_profiles (id, full_name, role, primary_location_id)
    values (v_owner_id, 'Test Owner', 'owner', v_location_id);

  insert into products (id, name) values (v_product_id, 'Test Product');
  insert into product_variants (id, product_id, sku) values (v_variant_id, v_product_id, 'TEST-SKU-IMMUTABILITY');

  -- Cost basis must exist BEFORE the sale: fn_populate_sale_item_cost_snapshot resolves
  -- variant_id -> product_id and looks up product_cost_history as of the sale's created_at,
  -- populating unit_cost_at_sale_cents itself -- the cashier's insert never supplies it
  -- (RLS makes cost unreadable to cashiers, so it can't be client-supplied; see the
  -- sales_and_returns and product_variants migrations). Cost stays product-keyed even
  -- though the sale line references the variant.
  insert into product_cost_history (product_id, unit_cost_cents, currency, effective_date)
    values (v_product_id, 600, 'USD', v_cost_before_sale);

  insert into sales (id, location_id, cashier_id, currency, subtotal_cents, total_cents, created_at)
    values (v_sale_id, v_location_id, v_owner_id, 'USD', 1000, 1000, v_sale_time);

  insert into sale_items (id, sale_id, variant_id, quantity, unit_selling_price_cents, currency)
    values (v_sale_item_id, v_sale_id, v_variant_id, 1, 1000, 'USD');

  select gross_profit_cents into v_profit_before from sale_items where id = v_sale_item_id;
  assert v_profit_before = 400,
    format('setup failed: expected gross_profit_cents = 400 (trigger-populated cost snapshot), got %s', v_profit_before);

  -- The owner changes the product's cost a few days AFTER the sale.
  insert into product_cost_history (product_id, unit_cost_cents, currency, effective_date)
    values (v_product_id, 9999, 'USD', v_cost_after_sale);

  select gross_profit_cents into v_profit_after from sale_items where id = v_sale_item_id;
  assert v_profit_after = v_profit_before,
    format('IMMUTABILITY VIOLATION: gross_profit_cents changed from %s to %s after a cost update',
      v_profit_before, v_profit_after);

  begin
    update sale_items set unit_cost_at_sale_cents = 1 where id = v_sale_item_id;
  exception when others then
    v_update_rejected := true;
  end;
  assert v_update_rejected, 'IMMUTABILITY VIOLATION: a direct UPDATE of unit_cost_at_sale_cents was not rejected';

  raise notice 'PASS: sale_items profit (%) is immutable to later product cost changes, and direct edits are rejected.', v_profit_after;
end $$;

rollback;
