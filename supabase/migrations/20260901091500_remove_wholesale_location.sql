-- Collapses the system to a single stock location, per explicit user direction: "remove
-- wholesale inventory functionality, focus on main store stock." This is about the
-- SECOND LOCATION specifically, not wholesale pricing -- retail vs wholesale price tiers,
-- min_wholesale_qty, and sale_type stay exactly as they are; a wholesale customer is still
-- a pricing tier, just no longer served from a separate stock location.
--
-- inventory_transfers / inventory_transfer_items are left in place (unused, harmless) --
-- dropping them is unnecessary destruction for tables that cost nothing to keep around if
-- a second location is ever reintroduced. transfers.html itself is removed at the UI layer
-- (see the accompanying commit), since a transfer needs two locations to mean anything.
--
-- ASSUMES NO TRANSACTIONAL HISTORY YET REFERENCES THE WHOLESALE LOCATION -- true today
-- (no live Supabase project has ever had this schema applied), but if this is ever run
-- against a project that already has real sales/receipts/counts/transfers/POs pointing at
-- the wholesale location, the final DELETE will fail on a foreign-key violation and those
-- rows would need migrating first.

do $$
declare
  v_shop_id uuid;
  v_wholesale_id uuid;
  r record;
begin
  select id into v_shop_id from locations where name = 'Subtle Accessories Shop';
  select id into v_wholesale_id from locations where name = 'Home / Wholesale Store';

  if v_wholesale_id is null then
    return; -- already removed (e.g. a second run of this migration) -- nothing to do
  end if;
  if v_shop_id is null then
    raise exception 'Cannot collapse locations: "Subtle Accessories Shop" was not found.';
  end if;

  -- Merge the wholesale location's stock into the shop's, per variant: sum quantity,
  -- blend weighted-average cost -- same math as fn_apply_transfer_receipt uses for a
  -- normal inter-location transfer, since that's conceptually what this is. Carries
  -- currency/needs_review forward too, not just quantity/cost, so a flagged or
  -- non-default-currency wholesale balance doesn't silently lose that state if the shop
  -- has no existing row for that variant yet.
  for r in
    select variant_id, quantity_available, average_unit_cost_cents, currency, needs_review, needs_review_reason
    from inventory_balances
    where location_id = v_wholesale_id
  loop
    insert into inventory_balances (variant_id, location_id, quantity_available, average_unit_cost_cents, currency, needs_review, needs_review_reason)
    values (r.variant_id, v_shop_id, r.quantity_available, r.average_unit_cost_cents, r.currency, r.needs_review, r.needs_review_reason)
    on conflict (variant_id, location_id) do update
      set quantity_available = inventory_balances.quantity_available + excluded.quantity_available,
          average_unit_cost_cents = case
            when inventory_balances.quantity_available + excluded.quantity_available = 0 then 0
            else (inventory_balances.quantity_available * inventory_balances.average_unit_cost_cents
                  + excluded.quantity_available * excluded.average_unit_cost_cents)
                 / (inventory_balances.quantity_available + excluded.quantity_available)
          end,
          needs_review = inventory_balances.needs_review or excluded.needs_review,
          updated_at = now();
  end loop;

  delete from inventory_balances where location_id = v_wholesale_id;

  -- Re-point anyone still assigned to the wholesale location (e.g. a wholesale_manager
  -- account) at the shop -- the ROLE stays (still meaningful for managing wholesale
  -- pricing/orders), only the location topology changes.
  update user_profiles set primary_location_id = v_shop_id where primary_location_id = v_wholesale_id;

  delete from locations where id = v_wholesale_id;
end $$;
