-- STEP 8 of the fashion-retail evolution: a lightweight customer directory. Deliberately
-- not a full CRM -- name, phone, optional email, and a link from sales so purchase history
-- can be shown. Phone is unique (where given) so checkout can find-or-create a customer by
-- phone without creating duplicates; name-only customers are never deduplicated (there's no
-- reliable natural key for a bare name).
create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create unique index customers_phone_unique on customers (phone) where phone is not null;

alter table sales add column customer_id uuid references customers (id);

alter table customers enable row level security;

-- Not sensitive financial data -- any authenticated role can look up or add a customer at
-- checkout, same trust level as ringing up a sale itself.
create policy customers_select on customers for select to authenticated using (true);
create policy customers_write on customers for all to authenticated using (true) with check (true);
