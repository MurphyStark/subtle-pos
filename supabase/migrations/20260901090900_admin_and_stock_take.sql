-- Product photos (admin UI) and stock-take reconciliation.

alter table products add column image_url text;

-- Supabase Storage bucket for product photos. Public read (photos render in the UI
-- without an authenticated fetch, and aren't sensitive); only managers/owner can write.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

alter table storage.objects enable row level security;

create policy product_images_public_read
  on storage.objects for select
  using (bucket_id = 'product-images');

create policy product_images_manager_insert
  on storage.objects for insert
  with check (bucket_id = 'product-images' and is_manager_or_owner());

create policy product_images_manager_update
  on storage.objects for update
  using (bucket_id = 'product-images' and is_manager_or_owner())
  with check (bucket_id = 'product-images' and is_manager_or_owner());

create policy product_images_manager_delete
  on storage.objects for delete
  using (bucket_id = 'product-images' and is_manager_or_owner());

-- Stock take reconciliation: once a stock_counts row is (or becomes) 'completed', set
-- each counted product's inventory_balances.quantity_available to exactly what was
-- physically counted -- a stock take is definitionally "this is the truth now", not
-- another adjustment layered on top of the running total. Clears any needs_review flag
-- too, since a fresh physical count supersedes whatever raised it.
--
-- Two separate triggers (not one combined INSERT-OR-UPDATE trigger) because a WHEN
-- clause referencing OLD is rejected by Postgres on a trigger that also fires on INSERT,
-- where OLD doesn't exist.
create or replace function fn_apply_stock_count_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select product_id, counted_quantity
    from stock_count_items
    where stock_count_id = new.id
  loop
    insert into inventory_balances (product_id, location_id, quantity_available)
    values (r.product_id, new.location_id, r.counted_quantity)
    on conflict (product_id, location_id) do update
      set quantity_available = r.counted_quantity,
          needs_review = false,
          needs_review_reason = null,
          updated_at = now();
  end loop;
  return new;
end;
$$;

create trigger stock_counts_apply_completion_insert
  after insert on stock_counts
  for each row
  when (new.status = 'completed')
  execute function fn_apply_stock_count_completion();

create trigger stock_counts_apply_completion_update
  after update on stock_counts
  for each row
  when (new.status = 'completed' and old.status is distinct from new.status)
  execute function fn_apply_stock_count_completion();
