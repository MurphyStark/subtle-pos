-- Reintroduces a second stock location -- a Warehouse -- that ONLY the owner can see or
-- touch. The shop stays the location everyone sells from; stock moves between the two via
-- inventory_transfers (the tables were left in place by remove_wholesale_location for
-- exactly this).
--
-- Enforcement is layered on top of the existing policies rather than rewriting them:
--   1. can_access_location(): true for the owner, otherwise true only for non-warehouse
--      locations.
--   2. locations_select is replaced so the Warehouse row itself is invisible to non-owners.
--   3. RESTRICTIVE policies on every table keyed by a location. Restrictive policies are
--      ANDed with the existing permissive ones, so every rule that already applied still
--      applies -- this only ever takes access away, never grants it.
--   4. v_inventory_balances (a view, which bypasses base-table RLS -- see the rls_policies
--      migration's header) gets the same filter in its WHERE clause.

insert into locations (name, location_type)
select 'Warehouse', 'warehouse'
where not exists (select 1 from locations where location_type = 'warehouse');

create or replace function can_access_location(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_owner()
      or p_location_id is null
      or not exists (select 1 from locations where id = p_location_id and location_type = 'warehouse');
$$;

grant execute on function can_access_location(uuid) to authenticated;

drop policy locations_select on locations;
create policy locations_select on locations for select to authenticated
  using (location_type <> 'warehouse' or is_owner());

create policy inventory_balances_location_guard on inventory_balances as restrictive for all to authenticated
  using (can_access_location(location_id)) with check (can_access_location(location_id));
create policy stock_receipts_location_guard on stock_receipts as restrictive for all to authenticated
  using (can_access_location(location_id)) with check (can_access_location(location_id));
create policy stock_counts_location_guard on stock_counts as restrictive for all to authenticated
  using (can_access_location(location_id)) with check (can_access_location(location_id));
create policy purchase_orders_location_guard on purchase_orders as restrictive for all to authenticated
  using (can_access_location(location_id)) with check (can_access_location(location_id));
create policy sales_location_guard on sales as restrictive for all to authenticated
  using (can_access_location(location_id)) with check (can_access_location(location_id));
create policy expenses_location_guard on expenses as restrictive for all to authenticated
  using (can_access_location(location_id)) with check (can_access_location(location_id));
create policy sale_item_returns_location_guard on sale_item_returns as restrictive for all to authenticated
  using (can_access_location(restock_location_id)) with check (can_access_location(restock_location_id));
create policy inventory_transfers_location_guard on inventory_transfers as restrictive for all to authenticated
  using (can_access_location(from_location_id) and can_access_location(to_location_id))
  with check (can_access_location(from_location_id) and can_access_location(to_location_id));
create policy inventory_transfer_items_location_guard on inventory_transfer_items as restrictive for all to authenticated
  using (exists (
    select 1 from inventory_transfers t
    where t.id = inventory_transfer_id
      and can_access_location(t.from_location_id) and can_access_location(t.to_location_id)
  ))
  with check (exists (
    select 1 from inventory_transfers t
    where t.id = inventory_transfer_id
      and can_access_location(t.from_location_id) and can_access_location(t.to_location_id)
  ));

create or replace view v_inventory_balances as
  select
    id, variant_id, location_id, quantity_available, currency, needs_review, updated_at,
    case when is_manager_or_owner() then average_unit_cost_cents end as average_unit_cost_cents
  from inventory_balances
  where can_access_location(location_id);
