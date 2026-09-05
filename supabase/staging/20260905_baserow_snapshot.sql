-- Apply this file explicitly after inventory. It is deliberately outside the
-- automatic app migrations. Never db reset, db push, or replay old QC migrations.
begin;
create schema frc190_baserow_stage;
revoke all on schema frc190_baserow_stage from public, anon, authenticated, service_role;
comment on schema frc190_baserow_stage is
  'Private, immutable Baserow migration snapshots. Not an application backend. No cutover.';

create table frc190_baserow_stage.snapshots (
  id uuid primary key,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  document jsonb not null check (document->>'version' = '1'),
  staged_at timestamptz not null default now(),
  check ((document->>'id')::uuid = id)
);
create table frc190_baserow_stage.source_tables (
  snapshot_id uuid not null references frc190_baserow_stage.snapshots(id),
  table_id bigint not null,
  fields jsonb not null,
  primary key (snapshot_id, table_id)
);
create table frc190_baserow_stage.source_rows (
  snapshot_id uuid not null,
  table_id bigint not null,
  row_id bigint not null,
  payload jsonb not null,
  primary key (snapshot_id, table_id, row_id),
  foreign key (snapshot_id, table_id) references frc190_baserow_stage.source_tables,
  check ((payload->>'id')::bigint = row_id)
);
create table frc190_baserow_stage.source_links (
  snapshot_id uuid not null,
  source_table_id bigint not null,
  source_row_id bigint not null,
  field_id bigint not null,
  position integer not null check (position >= 0),
  target_table_id bigint not null,
  target_row_id bigint not null,
  external boolean not null,
  -- MATCH SIMPLE skips the target FK only for the explicitly excluded tables.
  internal_target_table_id bigint generated always as
    (case when external then null else target_table_id end) stored,
  primary key (snapshot_id, source_table_id, source_row_id, field_id, position),
  foreign key (snapshot_id, source_table_id, source_row_id)
    references frc190_baserow_stage.source_rows(snapshot_id, table_id, row_id),
  foreign key (snapshot_id, internal_target_table_id, target_row_id)
    references frc190_baserow_stage.source_rows(snapshot_id, table_id, row_id),
  check (not external or target_table_id in (1119643, 1126322))
);
create table frc190_baserow_stage.qc_references (
  snapshot_id uuid not null references frc190_baserow_stage.snapshots(id),
  ordinal integer not null,
  requirement_table_id bigint not null default 1119642 check (requirement_table_id = 1119642),
  requirement_id bigint not null,
  provenance jsonb not null,
  primary key (snapshot_id, ordinal),
  foreign key (snapshot_id, requirement_table_id, requirement_id)
    references frc190_baserow_stage.source_rows(snapshot_id, table_id, row_id)
);

alter table frc190_baserow_stage.snapshots enable row level security;
alter table frc190_baserow_stage.source_tables enable row level security;
alter table frc190_baserow_stage.source_rows enable row level security;
alter table frc190_baserow_stage.source_links enable row level security;
alter table frc190_baserow_stage.qc_references enable row level security;
revoke all on all tables in schema frc190_baserow_stage from public, anon, authenticated, service_role;

create function frc190_baserow_stage.reject_snapshot_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Staged snapshots are immutable; capture a new snapshot instead';
end;
$$;
revoke all on function frc190_baserow_stage.reject_snapshot_change() from public, anon, authenticated, service_role;
do $$
declare name text;
begin
  foreach name in array array['snapshots','source_tables','source_rows','source_links','qc_references'] loop
    execute format('create trigger immutable_snapshot before update or delete or truncate on frc190_baserow_stage.%I for each statement execute function frc190_baserow_stage.reject_snapshot_change()', name);
  end loop;
end;
$$;
commit;
