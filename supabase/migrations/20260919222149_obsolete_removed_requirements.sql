-- Confirmed BOM removals use the same history, work guards, and claimant alerts.
begin;
create or replace function manufacturing.track_obsoletion_candidates() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists(select 1 from manufacturing.engineering_sync_runs where status='running') then return new; end if;
  if tg_op='INSERT' then
    if not coalesce(new.active_in_bom,false) then return new; end if;
  elsif not coalesce(new.active_in_bom,false) and not coalesce(old.active_in_bom,false) then
    -- Editing an already inactive historical row is not a new removal.
    return new;
  elsif row(new.active_in_bom,new.required_part_revision,new.source_assembly_revision)
    is not distinct from row(old.active_in_bom,old.required_part_revision,old.source_assembly_revision) then return new;
  end if;
  insert into manufacturing.obsoletion_sync_candidates values(txid_current(),new.id,not coalesce(new.active_in_bom,false))
    on conflict(transaction_id,requirement_id) do update set deactivated=excluded.deactivated;
  return new;
end;
$$;
revoke all on function manufacturing.track_obsoletion_candidates() from public, anon, authenticated, service_role;

create or replace function manufacturing.obsolete_after_engineering_sync() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  -- A partial run cannot establish that a complete replacement was published.
  if new.status='success' then
    with replacements as (
      select previous_req.id, min(replacement.id) as replacement_id
      from manufacturing.requirements previous_req
      join manufacturing.requirements replacement on replacement.active_in_bom
        and replacement.id<>previous_req.id and replacement.part_id=previous_req.part_id
        and replacement.assembly_id=previous_req.assembly_id and replacement.source_root=previous_req.source_root
        and coalesce(nullif(replacement.configuration,''),'default')=coalesce(nullif(previous_req.configuration,''),'default')
        and nullif(btrim(replacement.required_part_revision),'') is not null
        and replacement.required_part_revision<>previous_req.required_part_revision
      where not previous_req.active_in_bom and nullif(btrim(previous_req.required_part_revision),'') is not null
        and nullif(btrim(previous_req.source_root),'') is not null
        and (previous_req.obsolete_replacement_id is not null or exists (
          select 1 from manufacturing.obsoletion_sync_candidates c where c.transaction_id=txid_current()
            and c.requirement_id=previous_req.id and c.deactivated))
        and exists(select 1 from manufacturing.obsoletion_sync_candidates c where c.transaction_id=txid_current()
          and c.requirement_id=replacement.id and not c.deactivated)
        and not replacement.obsolete
        and 1=(select count(*) from manufacturing.requirements candidate
          where candidate.active_in_bom and candidate.part_id=previous_req.part_id
            and candidate.assembly_id=previous_req.assembly_id and candidate.source_root=previous_req.source_root
            and coalesce(nullif(candidate.configuration,''),'default')=coalesce(nullif(previous_req.configuration,''),'default'))
        and exists(select 1 from manufacturing.operations o where o.requirement_id=replacement.id and o.active_in_routing and o.status is not null)
      group by previous_req.id having count(*)=1
    )
    update manufacturing.requirements r set obsolete=true,
      obsoletion_version=r.obsoletion_version+1, obsoletion_changed_at=clock_timestamp(),
      obsoletion_changed_by='Engineering sync', obsoletion_origin=case when r.obsolete and r.obsoletion_origin='manual' then 'manual' else 'automatic' end,
      obsolete_replacement_id=x.replacement_id, updated_at=clock_timestamp()
    from replacements x where r.id=x.id and r.obsolete_replacement_id is distinct from x.replacement_id;
    -- A confirmed removal has no active requirement in the same scope.
    -- If an active candidate exists but is incomplete/ambiguous, retain the
    -- replacement validation above instead of treating it as a removal.
    update manufacturing.requirements r set obsolete=true,
      obsoletion_version=r.obsoletion_version+1,
      obsoletion_changed_at=clock_timestamp(), obsoletion_changed_by='Engineering sync',
      obsoletion_origin='automatic', obsolete_replacement_id=null, updated_at=clock_timestamp()
    where not r.active_in_bom and not r.obsolete
      and exists(select 1 from manufacturing.obsoletion_sync_candidates c
        where c.transaction_id=txid_current() and c.requirement_id=r.id and c.deactivated)
      and nullif(btrim(r.source_root),'') is not null
      and not exists(select 1 from manufacturing.requirements active_req
        where active_req.active_in_bom and active_req.part_id=r.part_id
          and active_req.assembly_id=r.assembly_id and active_req.source_root=r.source_root
          and coalesce(nullif(active_req.configuration,''),'default')=coalesce(nullif(r.configuration,''),'default'));
  end if;
  delete from manufacturing.obsoletion_sync_candidates where transaction_id=txid_current();
  return new;
end;
$$;
revoke all on function manufacturing.obsolete_after_engineering_sync() from public, anon, authenticated, service_role;

commit;
