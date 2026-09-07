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

create schema realtime;
create table realtime.messages (
  topic text not null,
  extension text not null default 'broadcast',
  payload jsonb,
  event text,
  private boolean not null default true
);
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable
as $$ select current_setting('realtime.topic', true) $$;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language sql security definer set search_path = ''
as $$ insert into realtime.messages(topic, extension, payload, event, private)
  values ($3, 'broadcast', $1, $2, $4) $$;

create schema frc190_baserow_stage;
create table frc190_baserow_stage.snapshots (id uuid primary key);

\ir ../../supabase/migrations/202609010001_admin_approval_and_qc.sql
\ir ../../supabase/migrations/202609040001_requirement_level_qc.sql
\ir ../../supabase/migrations/202609040002_qc_legacy_compatibility.sql
\ir ../../supabase/migrations/202609050001_qc_storage_locations.sql
\ir ../../supabase/migrations/20260905165307_part_locations.sql
\ir ../../supabase/production/20260905_normalized_manufacturing.sql
\ir ../../supabase/production/20260905_manufacturing_writes.sql
\ir ../../supabase/production/20260905_qc_storage_locations.sql
\ir ../../supabase/production/20260905_part_locations.sql
\ir ../../supabase/production/20260905_manufacturing_attachments.sql
\ir ../../supabase/production/20260906_manufacturing_realtime.sql
\ir ../../supabase/production/20260906_manufacturing_shared_cache.sql
