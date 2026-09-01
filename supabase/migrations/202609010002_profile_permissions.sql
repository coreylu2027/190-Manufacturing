-- RLS policies only filter rows after PostgreSQL grants access to the table.
-- Authenticated users need SELECT so they can read their own profile through
-- the policy created in the preceding migration.
grant select on table public.profiles to authenticated;
grant usage on type public.user_role to authenticated;

-- Administration and QC writes are performed only by authenticated server
-- routes using the server-only Supabase service credential.
grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.quality_control to service_role;
grant usage on type public.user_role to service_role;
grant usage on type public.quality_result to service_role;
