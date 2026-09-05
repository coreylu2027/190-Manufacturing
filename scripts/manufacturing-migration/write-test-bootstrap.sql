\set ON_ERROR_STOP on

-- Local-only compatibility shell for exercising the production write SQL with
-- a stock PostgreSQL server. Supabase provides these roles and auth tables in
-- hosted projects.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role noinherit bypassrls; end if;
end;
$$;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

create schema frc190_baserow_stage;
create table frc190_baserow_stage.snapshots (id uuid primary key);

\ir ../../supabase/migrations/202609010001_admin_approval_and_qc.sql
\ir ../../supabase/migrations/202609040001_requirement_level_qc.sql
\ir ../../supabase/migrations/202609040002_qc_legacy_compatibility.sql
\ir ../../supabase/production/20260905_normalized_manufacturing.sql
\ir ../../supabase/production/20260905_manufacturing_writes.sql
\ir ../../supabase/production/20260905_manufacturing_attachments.sql
