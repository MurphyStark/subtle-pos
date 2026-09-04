-- Row Level Security for the four PRD section 19 roles, enforced at the database layer.
--
-- IMPORTANT: Supabase gives every logged-in user the SAME Postgres role (`authenticated`)
-- regardless of their app-level role (cashier vs manager vs owner) -- app role lives in
-- user_profiles, not in a distinct Postgres role. That means plain column GRANT/REVOKE
-- cannot differentiate "cashier" from "manager", since both are the same Postgres role.
--
-- So for the two tables that mix figures a cashier must never see (cost, COGS, gross
-- profit) with figures a cashier legitimately needs (quantity, selling price): direct
-- SELECT on the base table is revoked from `authenticated` for EVERYONE, and all reads --
-- cashier and manager and owner alike -- go through a masking view instead. The view uses
-- is_manager_or_owner() to decide whether to return the real value or NULL. This means a
-- cashier's API/DB access is structurally incapable of returning cost or profit figures,
-- not just have them hidden in the frontend.
--
-- All application and reporting code must query v_sale_items / v_inventory_balances /
-- v_sale_item_returns -- never the underlying base tables. Direct base-table access remains
-- available to `service_role` (which bypasses RLS and grants entirely) for admin tooling.

alter table locations enable row level security;
alter table user_profiles enable row level security;
alter table suppliers enable row level security;
alter table currency_rates enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table product_prices enable row level security;
alter table product_cost_history enable row level security;
alter table inventory_balances enable row level security;
alter table stock_receipts enable row level security;
alter table stock_receipt_items enable row level security;
alter table stock_counts enable row level security;
alter table stock_count_items enable row level security;
alter table inventory_transfers enable row level security;
alter table inventory_transfer_items enable row level security;
alter table sales enable row level security;
alter table sale_payments enable row level security;
alter table sale_items enable row level security;
alter table sale_item_returns enable row level security;
alter table expenses enable row level security;
alter table profit_snapshots enable row level security;
alter table sync_queue enable row level security;

-- ---------------------------------------------------------------------------------------
-- Reference data: every authenticated role can read; only the owner (or manager, for
-- catalog/supplier data) administers.
-- ---------------------------------------------------------------------------------------
create policy locations_select on locations for select to authenticated using (true);
create policy locations_write on locations for all to authenticated
  using (is_owner()) with check (is_owner());

create policy user_profiles_select on user_profiles for select to authenticated
  using (id = auth.uid() or is_owner());
create policy user_profiles_write on user_profiles for all to authenticated
  using (is_owner()) with check (is_owner());

create policy suppliers_select on suppliers for select to authenticated
  using (is_manager_or_owner());
create policy suppliers_write on suppliers for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

create policy currency_rates_select on currency_rates for select to authenticated using (true);
create policy currency_rates_insert on currency_rates for insert to authenticated
  with check (is_owner());

create policy categories_select on categories for select to authenticated using (true);
create policy categories_write on categories for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

create policy products_select on products for select to authenticated using (true);
create policy products_write on products for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

-- Selling prices carry no cost data, so every role may read them.
create policy product_prices_select on product_prices for select to authenticated using (true);
create policy product_prices_insert on product_prices for insert to authenticated
  with check (is_manager_or_owner());

-- Cost is manager/owner-only, full stop -- cashiers get no policy here at all.
create policy product_cost_history_select on product_cost_history for select to authenticated
  using (is_manager_or_owner());
create policy product_cost_history_insert on product_cost_history for insert to authenticated
  with check (is_manager_or_owner());

-- ---------------------------------------------------------------------------------------
-- Inventory and receipts
-- ---------------------------------------------------------------------------------------
create policy inventory_balances_update on inventory_balances for update to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());
-- (no SELECT policy here on purpose -- base-table SELECT is revoked from `authenticated`
-- below; everyone reads through v_inventory_balances instead.)

create policy stock_receipts_all on stock_receipts for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());
create policy stock_receipt_items_all on stock_receipt_items for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

create policy stock_counts_select on stock_counts for select to authenticated
  using (
    is_manager_or_owner()
    or location_id = (select primary_location_id from user_profiles where id = auth.uid())
  );
create policy stock_counts_insert on stock_counts for insert to authenticated
  with check (
    is_manager_or_owner()
    or location_id = (select primary_location_id from user_profiles where id = auth.uid())
  );
create policy stock_count_items_select on stock_count_items for select to authenticated
  using (exists (
    select 1 from stock_counts sc where sc.id = stock_count_id
    and (is_manager_or_owner() or sc.location_id = (select primary_location_id from user_profiles where id = auth.uid()))
  ));
create policy stock_count_items_insert on stock_count_items for insert to authenticated
  with check (exists (
    select 1 from stock_counts sc where sc.id = stock_count_id
    and (is_manager_or_owner() or sc.location_id = (select primary_location_id from user_profiles where id = auth.uid()))
  ));

-- Whoever counted (or a manager/owner) can mark the count completed. stock_count_items
-- themselves aren't updated after insert in the normal flow (a miscount is corrected with
-- a fresh count), so only stock_counts gets an UPDATE policy.
create policy stock_counts_update on stock_counts for update to authenticated
  using (is_manager_or_owner() or counted_by = auth.uid())
  with check (is_manager_or_owner() or counted_by = auth.uid());

-- ---------------------------------------------------------------------------------------
-- Transfers: any role can request a transfer FROM their own location; only managers/owner
-- can progress the status flow (which is what actually moves stock, via the trigger).
-- ---------------------------------------------------------------------------------------
create policy inventory_transfers_select on inventory_transfers for select to authenticated
  using (
    is_manager_or_owner()
    or from_location_id = (select primary_location_id from user_profiles where id = auth.uid())
    or to_location_id = (select primary_location_id from user_profiles where id = auth.uid())
  );
create policy inventory_transfers_insert on inventory_transfers for insert to authenticated
  with check (
    status in ('draft', 'requested')
    and from_location_id = (select primary_location_id from user_profiles where id = auth.uid())
  );
create policy inventory_transfers_update on inventory_transfers for update to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

create policy inventory_transfer_items_select on inventory_transfer_items for select to authenticated
  using (exists (
    select 1 from inventory_transfers t where t.id = inventory_transfer_id
    and (
      is_manager_or_owner()
      or t.from_location_id = (select primary_location_id from user_profiles where id = auth.uid())
      or t.to_location_id = (select primary_location_id from user_profiles where id = auth.uid())
    )
  ));
create policy inventory_transfer_items_insert on inventory_transfer_items for insert to authenticated
  with check (exists (
    select 1 from inventory_transfers t where t.id = inventory_transfer_id
    and t.from_location_id = (select primary_location_id from user_profiles where id = auth.uid())
  ));
create policy inventory_transfer_items_update on inventory_transfer_items for update to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

-- ---------------------------------------------------------------------------------------
-- Sales: every role can ring up a sale at their own location.
-- ---------------------------------------------------------------------------------------
create policy sales_select on sales for select to authenticated
  using (
    is_manager_or_owner()
    or location_id = (select primary_location_id from user_profiles where id = auth.uid())
  );
-- A cashier/manager can only ring up sales at their own assigned location; the owner can
-- ring up a sale at either location, since they oversee both.
create policy sales_insert on sales for insert to authenticated
  with check (
    cashier_id = auth.uid()
    and (
      is_owner()
      or location_id = (select primary_location_id from user_profiles where id = auth.uid())
    )
  );

create policy sale_payments_select on sale_payments for select to authenticated
  using (exists (
    select 1 from sales s where s.id = sale_id
    and (is_manager_or_owner() or s.location_id = (select primary_location_id from user_profiles where id = auth.uid()))
  ));
create policy sale_payments_insert on sale_payments for insert to authenticated
  with check (exists (select 1 from sales s where s.id = sale_id and s.cashier_id = auth.uid()));

-- sale_items: INSERT is open to whoever owns the parent sale; base-table SELECT is revoked
-- from everyone below (see the masking-view section) so this table has no SELECT policy.
create policy sale_items_insert on sale_items for insert to authenticated
  with check (exists (select 1 from sales s where s.id = sale_id and s.cashier_id = auth.uid()));

-- sale_item_returns: any authenticated role may process a return (small-shop reality --
-- the app UI can gate this further per location's own process); base-table SELECT is
-- likewise revoked below in favor of v_sale_item_returns.
create policy sale_item_returns_insert on sale_item_returns for insert to authenticated with check (true);

-- ---------------------------------------------------------------------------------------
-- Expenses and profit reporting: manager/owner only, never cashier.
-- ---------------------------------------------------------------------------------------
create policy expenses_all on expenses for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());
create policy profit_snapshots_all on profit_snapshots for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());
-- Any role can queue and later resolve its own offline outbox entries -- the security
-- boundary lives on the entity-specific table each queued entity_type actually inserts
-- into (sales, sale_items, ...), not on this bookkeeping table.
create policy sync_queue_select on sync_queue for select to authenticated
  using (is_manager_or_owner() or created_by = auth.uid());
create policy sync_queue_insert on sync_queue for insert to authenticated
  with check (is_manager_or_owner() or created_by = auth.uid());
create policy sync_queue_update on sync_queue for update to authenticated
  using (is_manager_or_owner() or created_by = auth.uid())
  with check (is_manager_or_owner() or created_by = auth.uid());

-- ---------------------------------------------------------------------------------------
-- Column-level masking for cashiers, via views (see the header note above for why this
-- can't be done with plain GRANT/REVOKE in Supabase's single-Postgres-role model).
--
-- DELIBERATE EXCEPTION to "always use security_invoker = true": these three views are
-- created WITHOUT security_invoker, so they run with the view owner's privileges and
-- bypass sale_items/inventory_balances/sale_item_returns' own RLS entirely. That's
-- necessary here -- a security_invoker view would still require the caller to hold a base
-- table SELECT grant, which reintroduces the exact "authenticated is one shared role"
-- problem this design is working around. Because RLS is bypassed for these three tables,
-- row-level scoping (which location's rows a role may see) is reimplemented explicitly in
-- each view's WHERE clause below, and column masking is done with is_manager_or_owner().
-- Both are handled by these views, not by any policy on the base tables.
-- ---------------------------------------------------------------------------------------
revoke select on sale_items from authenticated;
revoke select on inventory_balances from authenticated;
revoke select on sale_item_returns from authenticated;

create view v_sale_items as
  select
    si.id, si.sale_id, si.product_id, si.quantity, si.unit_selling_price_cents, si.currency,
    si.exchange_rate_at_sale, si.created_at,
    case when is_manager_or_owner() then si.unit_cost_at_sale_cents end as unit_cost_at_sale_cents,
    case when is_manager_or_owner() then si.cost_of_goods_sold_cents end as cost_of_goods_sold_cents,
    case when is_manager_or_owner() then si.gross_profit_cents end as gross_profit_cents
  from sale_items si
  join sales s on s.id = si.sale_id
  where is_manager_or_owner()
     or s.location_id = (select primary_location_id from user_profiles where id = auth.uid());

-- Quantity isn't sensitive (only cost is), so no row-location filter here -- every role can
-- see stock availability at every location, which is normal POS/ops behavior.
create view v_inventory_balances as
  select
    id, product_id, location_id, quantity_available, currency, needs_review, updated_at,
    case when is_manager_or_owner() then average_unit_cost_cents end as average_unit_cost_cents
  from inventory_balances;

create view v_sale_item_returns as
  select
    r.id, r.sale_item_id, r.quantity_returned, r.restock_location_id, r.reason, r.refund_amount_cents,
    r.processed_by, r.sync_status, r.created_at,
    case when is_manager_or_owner() then r.cogs_reversed_cents end as cogs_reversed_cents,
    case when is_manager_or_owner() then r.gross_profit_reversed_cents end as gross_profit_reversed_cents
  from sale_item_returns r
  join sale_items si on si.id = r.sale_item_id
  join sales s on s.id = si.sale_id
  where is_manager_or_owner()
     or s.location_id = (select primary_location_id from user_profiles where id = auth.uid());

grant select on v_sale_items to authenticated;
grant select on v_inventory_balances to authenticated;
grant select on v_sale_item_returns to authenticated;
