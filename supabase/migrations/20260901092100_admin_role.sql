-- The admin role: everything the owner can do, plus the Warehouse, which is now admin-only.
-- The shop's owner (Tracy) keeps full control of the shop but no longer sees the Warehouse.
--
-- Admin inherits owner/manager powers by widening is_owner() and is_manager_or_owner()
-- rather than touching every policy that calls them. Warehouse access moves from
-- is_owner() to the new is_admin() in the two places the warehouse_location migration
-- used it: can_access_location() (which every restrictive location guard and
-- v_inventory_balances call) and the locations_select policy.

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select current_user_role() = 'admin';
$$;

grant execute on function is_admin() to authenticated;

create or replace function is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select current_user_role() in ('owner', 'admin');
$$;

create or replace function is_manager_or_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select current_user_role() in ('shop_manager', 'wholesale_manager', 'owner', 'admin');
$$;

create or replace function can_access_location(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select is_admin()
      or p_location_id is null
      or not exists (select 1 from locations where id = p_location_id and location_type = 'warehouse');
$$;

drop policy locations_select on locations;
create policy locations_select on locations for select to authenticated
  using (location_type <> 'warehouse' or is_admin());

create or replace function verify_manager_pin(p_pin text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from user_profiles
  where manager_pin = p_pin
    and role in ('shop_manager', 'wholesale_manager', 'owner', 'admin')
    and p_pin is not null
    and p_pin <> ''
  limit 1;
$$;

-- Without this, the owner -- who may write user_profiles (user_profiles_write: is_owner()) --
-- could simply set their own role to 'admin'. Only an admin may create, change or delete an
-- admin profile, or make anyone an admin. Reads are left alone so the admin's name still
-- shows up in the activity log. RESTRICTIVE, so it only narrows the existing policies.
create policy user_profiles_admin_guard_insert on user_profiles as restrictive for insert to authenticated
  with check (role <> 'admin' or is_admin());
create policy user_profiles_admin_guard_update on user_profiles as restrictive for update to authenticated
  using (role <> 'admin' or is_admin())
  with check (role <> 'admin' or is_admin());
create policy user_profiles_admin_guard_delete on user_profiles as restrictive for delete to authenticated
  using (role <> 'admin' or is_admin());
