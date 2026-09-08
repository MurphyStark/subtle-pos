-- STEP 9 of the fashion-retail evolution: discount codes replace the free-text discount
-- field, plus a manager-PIN gate on manual discounts above a configurable cap.
--
-- PIN DESIGN NOTE: a cashier applying a manual discount above the cap needs some way to
-- confirm a manager approved it, WITHOUT the manager logging out the cashier's session to
-- log in themselves (that's the whole point of a quick PIN, as opposed to a full
-- password). But user_profiles' own RLS (id = auth.uid() or is_owner()) means a cashier
-- cannot read ANY other user's row, including a manager's PIN -- so the check can't happen
-- as a plain SELECT from the client. verify_manager_pin() is a SECURITY DEFINER RPC that
-- bypasses that restriction internally: it takes a PIN and returns the id of the
-- manager/owner it belongs to (or null if no match) -- enough for the audit trail
-- (sales.discount_approved_by below) to record WHO approved it, without ever exposing the
-- PIN value itself or letting a cashier enumerate anyone else's PIN. manager_pin has a
-- partial unique index (below) specifically so "the id it belongs to" is unambiguous.
create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table app_settings enable row level security;
create policy app_settings_select on app_settings for select to authenticated using (true);
create policy app_settings_write on app_settings for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

insert into app_settings (key, value) values ('manual_discount_cap_cents', '2000'); -- $20.00 default

alter table user_profiles add column manager_pin text; -- self-set by a manager/owner; see verify_manager_pin()

-- Partial unique index (not a plain UNIQUE constraint, so many NULLs -- managers who never
-- set a PIN -- are still allowed) makes "the manager this PIN belongs to" unambiguous.
create unique index user_profiles_manager_pin_unique on user_profiles (manager_pin) where manager_pin is not null;

create or replace function verify_manager_pin(p_pin text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from user_profiles
  where manager_pin = p_pin
    and role in ('shop_manager', 'wholesale_manager', 'owner')
    and p_pin is not null
    and p_pin <> ''
  limit 1;
$$;

grant execute on function verify_manager_pin(text) to authenticated;

create type discount_type as enum ('percentage', 'fixed');

create table discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_type discount_type not null,
  discount_value numeric(10, 2) not null check (discount_value > 0), -- percentage (e.g. 10 = 10%) or cents-equivalent fixed amount, per discount_type
  min_spend_cents bigint not null default 0 check (min_spend_cents >= 0),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  is_active boolean not null default true,
  created_by uuid references user_profiles (id),
  created_at timestamptz not null default now()
);

alter table discount_codes enable row level security;
-- Every role needs to validate a code at checkout; only managers/owner create/edit them.
create policy discount_codes_select on discount_codes for select to authenticated using (true);
create policy discount_codes_write on discount_codes for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

-- Records how a sale's discount was actually arrived at -- a code, a manual amount under
-- the cap, or a manual amount a manager's PIN approved -- for the activity/audit trail
-- (see the activity_and_presence migration). Not a new discount mechanism of its own.
alter table sales add column discount_code text references discount_codes (code);
alter table sales add column discount_approved_by uuid references user_profiles (id);
