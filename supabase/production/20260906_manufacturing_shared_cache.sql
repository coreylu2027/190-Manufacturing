-- Give every application instance a cheap, common cache key for the current
-- manufacturing projection. This follows the Realtime rollout and is safe to
-- apply whether or not manufacturing data already exists.
begin;

create table manufacturing.data_version (
  singleton boolean primary key default true check (singleton),
  version bigint not null,
  changed_at timestamptz not null default clock_timestamp()
);

insert into manufacturing.data_version (singleton, version)
values (true, txid_current());

alter table manufacturing.data_version enable row level security;
revoke all on manufacturing.data_version from public, anon, authenticated, service_role;

create function public.manufacturing_data_version()
returns text
language sql
stable
security definer
set search_path = ''
as $version$
  select version::text
  from manufacturing.data_version
  where singleton
$version$;

revoke all on function public.manufacturing_data_version() from public, anon, authenticated;
grant execute on function public.manufacturing_data_version() to service_role;

create or replace function manufacturing.broadcast_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $broadcast$
declare
  current_version bigint := txid_current();
begin
  insert into manufacturing.data_version (singleton, version, changed_at)
  values (true, current_version, clock_timestamp())
  on conflict (singleton) do update
  set version = excluded.version,
      changed_at = excluded.changed_at;

  -- The version is a cache key, not row data. Private manufacturing columns
  -- remain available only through authenticated server routes.
  perform realtime.send(
    jsonb_build_object('version', current_version::text),
    'changed',
    'manufacturing:changes',
    true
  );
  return null;
end;
$broadcast$;

revoke all on function manufacturing.broadcast_change() from public, anon, authenticated, service_role;

-- The invalidation does not inspect OLD or NEW, so statement triggers preserve
-- correctness while turning a bulk import into one event per changed table.
drop trigger if exists broadcast_manufacturing_change on manufacturing.assemblies;
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.assemblies
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_change on manufacturing.parts;
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.parts
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_change on manufacturing.requirements;
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.requirements
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_change on manufacturing.operations;
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.operations
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_change on manufacturing.finishing;
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.finishing
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_change on manufacturing.operation_allocations;
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.operation_allocations
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_change on manufacturing.quality_review_retractions;
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.quality_review_retractions
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_change on manufacturing.attachments;
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.attachments
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_change on public.quality_control;
create trigger broadcast_manufacturing_change
  after insert or update or delete on public.quality_control
  for each statement execute function manufacturing.broadcast_change();
drop trigger if exists broadcast_manufacturing_profile_change on public.profiles;
create trigger broadcast_manufacturing_profile_change
  after insert or delete or update of display_name, role, approved on public.profiles
  for each statement execute function manufacturing.broadcast_change();

commit;
