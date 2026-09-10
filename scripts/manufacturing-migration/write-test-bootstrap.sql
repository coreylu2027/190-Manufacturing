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
\ir ../../supabase/migrations/202609010005_profile_last_seen.sql
\ir ../../supabase/migrations/202609040001_requirement_level_qc.sql
\ir ../../supabase/migrations/202609040002_qc_legacy_compatibility.sql
\ir ../../supabase/migrations/202609050001_qc_storage_locations.sql
\ir ../../supabase/migrations/20260905165307_part_locations.sql
\ir ../../supabase/migrations/20260909174808_qc_rejected_quantities.sql
\ir ../../supabase/production/20260905_normalized_manufacturing.sql
\ir ../../supabase/production/20260905_manufacturing_writes.sql
\ir ../../supabase/production/20260905_qc_storage_locations.sql
\ir ../../supabase/production/20260905_part_locations.sql

-- Exercise the one-time legacy reset before installing the new QC wrapper.
insert into manufacturing.requirements (
  id, source_row, production_key, required_quantity, active_in_bom,
  status, qc_outcome
) values (
  -191, '{"id":-191,"Status":{"value":"Needs Rework"},"Required Quantity":2,"QC Outcome":{"value":"Failed"}}',
  'legacy-rework-test', 2, true, 'Needs Rework', 'Failed'
);
insert into manufacturing.operations (
  id, source_row, operation_key, requirement_id, operation_number, machine,
  work_type, active_in_routing, status, machinist, claimed_quantity,
  completed_quantity, quantity_ledger, completed_at
) values
  (-191, '{}', 'legacy-rework-test|OP1', -191, 'OP1', 'Mill', 'Manufacturing', true,
    'Needs Rework', 'Legacy (2)', 0, 2,
    '[{"userId":"legacy","name":"Legacy","claimed":0,"completed":2}]', clock_timestamp()),
  (-192, '{}', 'legacy-rework-test|OP2', -191, 'OP2', 'Lathe', 'Manufacturing', true,
    'Complete', 'Legacy (2)', 0, 2,
    '[{"userId":"legacy","name":"Legacy","claimed":0,"completed":2}]', clock_timestamp()),
  (-193, '{}', 'legacy-rework-test|OP1|CAM', -191, 'OP1', 'Mill', 'CAM', true,
    'Complete', 'Legacy', 0, 1,
    '[{"userId":"legacy","name":"Legacy","claimed":0,"completed":1}]', clock_timestamp());
insert into manufacturing.operation_allocations (
  operation_id, ordinal, user_id, display_name, claimed, completed, source_allocation
) values
  (-191, 0, 'legacy', 'Legacy', 0, 2, '{}'),
  (-192, 0, 'legacy', 'Legacy', 0, 2, '{}'),
  (-193, 0, 'legacy', 'Legacy', 0, 1, '{}');

\ir ../../supabase/production/20260909_qc_rejected_quantities.sql

do $$
begin
  if exists(select 1 from manufacturing.requirements where status = 'Needs Rework')
    or exists(select 1 from manufacturing.operations where status = 'Needs Rework')
    or (select status from manufacturing.requirements where id = -191) <> 'Ready for Manufacturing'
    or (select status from manufacturing.operations where id = -191) <> 'Ready'
    or (select status from manufacturing.operations where id = -192) <> 'Planned'
    or exists(select 1 from manufacturing.operations where id in (-191, -192)
      and (claimed_quantity <> 0 or completed_quantity <> 0 or completed_at is not null))
    or exists(select 1 from manufacturing.operation_allocations where operation_id in (-191, -192))
    or (select status from manufacturing.operations where id = -193) <> 'Complete'
    or (select completed_quantity from manufacturing.operations where id = -193) <> 1 then
    raise exception 'Legacy Needs Rework migration did not fully reset physical work and preserve CAM';
  end if;
end;
$$;

\ir ../../supabase/production/20260905_manufacturing_attachments.sql
\ir ../../supabase/production/20260906_manufacturing_realtime.sql
\ir ../../supabase/production/20260906_manufacturing_shared_cache.sql
\ir ../../supabase/production/20260909_requirement_notes.sql
