-- Adds an 'admin' role above 'owner'. Kept alone in its own migration because Postgres
-- won't let a newly added enum value be used in the same transaction that adds it; the
-- functions and policies that reference 'admin' follow in 20260901092100_admin_role.sql.
alter type user_role add value if not exists 'admin';
