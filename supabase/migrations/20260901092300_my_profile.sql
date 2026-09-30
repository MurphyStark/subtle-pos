-- "My Profile": everyone can edit their own name, job title, phone numbers and photo --
-- and nothing else (not their role, location or anyone else's row).
--
-- user_profiles writes are owner-only under RLS (user_profiles_write), so self-service goes
-- through narrow SECURITY DEFINER functions keyed on auth.uid() instead of a broad
-- "update own row" policy, which would also let people change their own role.
--
-- touch_my_presence() fixes the presence heartbeat for non-owners: it updated
-- last_seen_at directly, which RLS silently rejected, so cashiers always showed offline.

alter table user_profiles add column avatar_url text;
alter table user_profiles add column job_title text;
alter table user_profiles add column phone text;
alter table user_profiles add column alt_phone text;

create or replace function update_my_profile(p_full_name text, p_job_title text, p_phone text, p_alt_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(btrim(p_full_name), '') = '' then
    raise exception 'Full name is required';
  end if;
  update user_profiles
     set full_name = btrim(p_full_name),
         job_title = nullif(btrim(p_job_title), ''),
         phone = nullif(btrim(p_phone), ''),
         alt_phone = nullif(btrim(p_alt_phone), '')
   where id = auth.uid();
end;
$$;

create or replace function set_my_avatar(p_avatar_url text)
returns void
language sql
security definer
set search_path = public
as $$
  update user_profiles set avatar_url = nullif(p_avatar_url, '') where id = auth.uid();
$$;

create or replace function touch_my_presence()
returns void
language sql
security definer
set search_path = public
as $$
  update user_profiles set last_seen_at = now() where id = auth.uid();
$$;

grant execute on function update_my_profile(text, text, text, text) to authenticated;
grant execute on function set_my_avatar(text) to authenticated;
grant execute on function touch_my_presence() to authenticated;

-- Profile photos: public read (they render in the UI), and each person may only write
-- inside their own folder: avatars/<their user id>/...
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy avatars_public_read on storage.objects for select
  using (bucket_id = 'avatars');
create policy avatars_own_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_own_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
