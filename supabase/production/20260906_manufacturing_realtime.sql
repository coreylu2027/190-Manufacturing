-- Apply after the normalized manufacturing, write, location, and attachment
-- production scripts. Clients receive only an invalidation signal; the private
-- manufacturing rows remain available exclusively through the server adapter.
begin;

create policy "Approved users can receive manufacturing changes"
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and (select realtime.topic()) = 'manufacturing:changes'
    and exists (
      select 1
      from public.profiles
      where id = (select auth.uid())
        and approved
    )
  );

create function manufacturing.broadcast_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $broadcast$
begin
  -- Deliberately omit NEW and OLD: browsers only need to know that their
  -- server-projected view is stale, not which private columns changed.
  perform realtime.send(
    '{}'::jsonb,
    'changed',
    'manufacturing:changes',
    true
  );
  return null;
end;
$broadcast$;

revoke all on function manufacturing.broadcast_change() from public, anon, authenticated, service_role;

create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.assemblies
  for each row execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.parts
  for each row execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.requirements
  for each row execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.operations
  for each row execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.finishing
  for each row execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.operation_allocations
  for each row execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.quality_review_retractions
  for each row execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change
  after insert or update or delete on manufacturing.attachments
  for each row execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change
  after insert or update or delete on public.quality_control
  for each row execute function manufacturing.broadcast_change();

-- Ignore last_seen_at heartbeat writes; only profile fields that can change a
-- rendered workspace or its authorization need to refresh connected clients.
create trigger broadcast_manufacturing_profile_change
  after insert or delete or update of display_name, role, approved on public.profiles
  for each row execute function manufacturing.broadcast_change();

commit;
