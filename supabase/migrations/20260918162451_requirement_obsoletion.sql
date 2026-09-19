-- Apply after normalized manufacturing, production writes, notes, and engineering sync.
begin;

alter table manufacturing.requirements
  add column obsolete boolean not null default false,
  add column obsoletion_version bigint not null default 0,
  add column obsoletion_changed_at timestamptz,
  add column obsoletion_changed_by text,
  add column obsoletion_origin text check (obsoletion_origin in ('manual','automatic')),
  add column obsolete_replacement_id bigint references manufacturing.requirements(id);

create index requirements_replacement_scope_idx on manufacturing.requirements(part_id,assembly_id,source_root) where active_in_bom;
create index requirements_obsolete_replacement_idx on manufacturing.requirements(obsolete_replacement_id) where obsolete_replacement_id is not null;

create table manufacturing.obsoletion_history (
  id bigint generated always as identity primary key,
  requirement_id bigint not null references manufacturing.requirements(id),
  obsolete boolean not null,
  version bigint not null,
  changed_at timestamptz not null,
  changed_by text,
  origin text not null,
  replacement_id bigint references manufacturing.requirements(id)
);
alter table manufacturing.obsoletion_history enable row level security;
create index obsoletion_history_requirement_idx on manufacturing.obsoletion_history(requirement_id,version);
revoke all on manufacturing.obsoletion_history from public, anon, authenticated, service_role;
create trigger immutable before update or delete or truncate on manufacturing.obsoletion_history
  for each statement execute function manufacturing.prevent_history_change();

create function manufacturing.record_obsoletion() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.obsoletion_version is distinct from old.obsoletion_version then
    insert into manufacturing.obsoletion_history(requirement_id,obsolete,version,changed_at,changed_by,origin,replacement_id)
      values(new.id,new.obsolete,new.obsoletion_version,new.obsoletion_changed_at,new.obsoletion_changed_by,
        new.obsoletion_origin,new.obsolete_replacement_id);
  end if;
  return new;
end;
$$;
revoke all on function manufacturing.record_obsoletion() from public, anon, authenticated, service_role;
create trigger record_obsoletion after update on manufacturing.requirements
  for each row execute function manufacturing.record_obsoletion();

-- Same service-only boundary, actor checks, retry IDs, and snapshot CAS as notes.
create function public.manufacturing_set_requirement_obsolete(
  p_request_id uuid, p_actor uuid, p_expected text, p_requirement_id bigint,
  p_obsolete boolean, p_version bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prior manufacturing.write_requests; fingerprint text; before_row jsonb; after_row jsonb;
  result jsonb; actor_name text;
begin
  set local lock_timeout = '5s';
  lock table manufacturing.write_control, manufacturing.write_requests,
    manufacturing.requirements, manufacturing.write_history in share row exclusive mode;
  if not exists(select 1 from manufacturing.write_control where enabled) then
    raise exception 'Supabase manufacturing writes are disabled' using errcode='42501';
  end if;
  select display_name into actor_name from public.profiles where id=p_actor and approved for share;
  if not found then raise exception 'Approved actor required' using errcode='42501'; end if;
  if p_request_id is null or p_obsolete is null or p_version is null or p_version < 0 then
    raise exception 'Invalid obsoletion request';
  end if;
  fingerprint := md5(jsonb_build_array(p_actor,p_expected,p_requirement_id,p_obsolete,p_version)::text);
  select * into prior from manufacturing.write_requests where request_id=p_request_id;
  if found then
    if prior.payload_hash <> fingerprint then raise sqlstate 'PT409' using message='Request ID reused with different payload'; end if;
    return prior.result;
  end if;
  if p_expected is distinct from md5(manufacturing.write_snapshot()::text) then
    raise sqlstate 'PT409' using message='Manufacturing state changed';
  end if;
  select to_jsonb(r) into before_row from manufacturing.requirements r where id=p_requirement_id;
  if before_row is null or (before_row->>'obsoletion_version')::bigint <> p_version then
    raise sqlstate 'PT409' using message='Obsoletion changed. Refresh before trying again.';
  end if;
  if (before_row->>'obsolete')::boolean = p_obsolete then
    raise sqlstate 'PT409' using message='This requirement already has that obsoletion state';
  end if;
  result := jsonb_build_object('requirementId',p_requirement_id,'obsolete',p_obsolete,'obsoletionVersion',p_version+1);
  insert into manufacturing.write_requests(request_id,actor,action,payload_hash,result)
    values(p_request_id,p_actor,'requirement_obsoletion',fingerprint,result);
  update manufacturing.requirements r set obsolete=p_obsolete, obsoletion_version=p_version+1,
    obsoletion_changed_at=clock_timestamp(), obsoletion_changed_by=coalesce(actor_name,p_actor::text),
    obsoletion_origin='manual', updated_at=clock_timestamp()
    where id=p_requirement_id returning to_jsonb(r) into after_row;
  insert into manufacturing.write_history(request_id,entity,row_id,before_row,after_row)
    values(p_request_id,'requirements',p_requirement_id,before_row,after_row);
  return result;
end;
$$;
revoke all on function public.manufacturing_set_requirement_obsolete(uuid,uuid,text,bigint,boolean,bigint)
  from public, anon, authenticated;
grant execute on function public.manufacturing_set_requirement_obsolete(uuid,uuid,text,bigint,boolean,bigint) to service_role;

-- Defense in depth for the existing write RPCs. Notes and off-robot locations
-- remain editable; engineering routing changes do not erase shop history.
create function manufacturing.guard_obsolete_work() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare requirement_id bigint;
begin
  if tg_table_name='requirements' then
    if old.obsolete and (
      row(new.status,new.machinist,new.qc_outcome) is distinct from row(old.status,old.machinist,old.qc_outcome)
      or (new.part_location='On Robot' and new.part_location is distinct from old.part_location)
    ) then raise sqlstate 'PT409' using message='This requirement is obsolete. Do not manufacture or install it.'; end if;
    return new;
  end if;
  requirement_id := new.requirement_id;
  if not exists(select 1 from manufacturing.requirements r where r.id=requirement_id and r.obsolete) then return new; end if;
  if tg_table_name='operations' then
    if row(new.status,new.claimed_quantity,new.completed_quantity,new.quantity_ledger,new.cam_program_path,new.cam_notes,new.started_at,new.completed_at)
      is not distinct from row(old.status,old.claimed_quantity,old.completed_quantity,old.quantity_ledger,old.cam_program_path,old.cam_notes,old.started_at,old.completed_at)
      then return new; end if;
  elsif tg_table_name='finishing' and new.machinist is not distinct from old.machinist then return new;
  end if;
  raise sqlstate 'PT409' using message='This requirement is obsolete. Do not manufacture or install it.';
end;
$$;
revoke all on function manufacturing.guard_obsolete_work() from public, anon, authenticated, service_role;
create trigger guard_obsolete_work before update on manufacturing.requirements for each row execute function manufacturing.guard_obsolete_work();
create trigger guard_obsolete_work before update on manufacturing.operations for each row execute function manufacturing.guard_obsolete_work();
create trigger guard_obsolete_work before update on manufacturing.finishing for each row execute function manufacturing.guard_obsolete_work();

-- Track only changes made in the current sync transaction, never guess which
-- pre-existing inactive requirements were superseded before this migration.
create table manufacturing.obsoletion_sync_candidates (
  transaction_id bigint not null,
  requirement_id bigint not null references manufacturing.requirements(id),
  deactivated boolean not null,
  primary key(transaction_id,requirement_id)
);
alter table manufacturing.obsoletion_sync_candidates enable row level security;
revoke all on manufacturing.obsoletion_sync_candidates from public, anon, authenticated, service_role;
create function manufacturing.track_obsoletion_candidates() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not exists(select 1 from manufacturing.engineering_sync_runs where status='running') then return new; end if;
  if tg_op='INSERT' then
    if not coalesce(new.active_in_bom,false) then return new; end if;
  elsif row(new.active_in_bom,new.required_part_revision,new.source_assembly_revision)
    is not distinct from row(old.active_in_bom,old.required_part_revision,old.source_assembly_revision) then return new;
  end if;
  insert into manufacturing.obsoletion_sync_candidates values(txid_current(),new.id,not coalesce(new.active_in_bom,false))
    on conflict(transaction_id,requirement_id) do update set deactivated=excluded.deactivated;
  return new;
end;
$$;
revoke all on function manufacturing.track_obsoletion_candidates() from public, anon, authenticated, service_role;
create trigger track_obsoletion_candidates after insert or update on manufacturing.requirements
  for each row execute function manufacturing.track_obsoletion_candidates();

create function manufacturing.obsolete_after_engineering_sync() returns trigger
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
  end if;
  delete from manufacturing.obsoletion_sync_candidates where transaction_id=txid_current();
  return new;
end;
$$;
revoke all on function manufacturing.obsolete_after_engineering_sync() from public, anon, authenticated, service_role;
-- Alphabetical trigger order runs routing initialization before this hook.
create trigger obsolete_after_engineering_sync after update of status on manufacturing.engineering_sync_runs
  for each row when(old.status='running' and new.status in ('success','partial','failed'))
  execute function manufacturing.obsolete_after_engineering_sync();

-- Manual stop-work flags also prevent sync from initializing new work on that requirement.
create or replace function manufacturing.initialize_synced_routing()
returns void language plpgsql security invoker set search_path = '' as $$
declare
  requirement manufacturing.requirements;
  target manufacturing.operations;
  new_operation_ids bigint[];
begin
  perform pg_catalog.pg_advisory_xact_lock(190, 20260905);
  for requirement in
    select r.* from manufacturing.requirements r
    where r.active_in_bom and not r.obsolete and (r.status is null or exists (
      select 1 from manufacturing.operations o
      where o.requirement_id=r.id and o.active_in_routing and o.status is null
    )) order by r.id for update
  loop
    -- Rows with any evidence of shop work require explicit review, not an
    -- inferred completion or an automatically inserted CAM prerequisite.
    select coalesce(array_agg(o.id), '{}'::bigint[]) into new_operation_ids
    from manufacturing.operations o
    where o.requirement_id=requirement.id and o.active_in_routing
      and o.status is null and o.started_at is null and o.completed_at is null
      and coalesce(o.claimed_quantity,0)=0 and coalesce(o.completed_quantity,0)=0
      and coalesce(o.quantity_ledger,'') in ('','[]')
      and coalesce(o.machinist,'')='';

    for target in select o.* from manufacturing.operations o
      where o.id=any(new_operation_ids) and o.work_type='Manufacturing'
        and o.machine in ('Haas CNC','Shop Sabre CNC')
    loop
      if not exists (select 1 from manufacturing.operations cam
        where cam.requirement_id=requirement.id and cam.operation_number=target.operation_number
          and cam.work_type='CAM') then
        insert into manufacturing.operations (
          operation_key,requirement_id,operation_number,machine,work_type,
          active_in_routing,status,claimed_quantity,completed_quantity,quantity_ledger
        ) values (
          requirement.production_key||'|CAM|'||target.operation_number,
          requirement.id,target.operation_number,target.machine,'CAM',true,'Ready',0,0,'[]'
        );
      end if;
    end loop;

    update manufacturing.operations o set status=case when o.work_type='CAM' then 'Ready' else 'Planned' end,
      updated_at=clock_timestamp()
    where o.id=any(new_operation_ids);

    -- Release only the first incomplete stage in each phase, respecting CAM,
    -- QC, and finishing. A later CAM task is ready independently of machining.
    update manufacturing.operations o set status='Ready',updated_at=clock_timestamp()
    where o.id=any(new_operation_ids) and o.work_type='Manufacturing'
      and (o.machine is distinct from 'Threaded Insert' or (
        requirement.qc_outcome='Passed' and (
          coalesce(requirement.finishing,'None') in ('','None') or
          requirement.status not in ('Ready for QC','Ready for Finishing')
        )
      ))
      and (o.machine not in ('Haas CNC','Shop Sabre CNC') or exists (
        select 1 from manufacturing.operations cam
        where cam.requirement_id=requirement.id and cam.operation_number=o.operation_number
          and cam.work_type='CAM' and cam.active_in_routing and cam.status='Complete'
      ))
      and not exists (
        select 1 from manufacturing.operations earlier
        where earlier.requirement_id=requirement.id and earlier.active_in_routing
          and earlier.work_type='Manufacturing'
          and (earlier.machine='Threaded Insert') is not distinct from (o.machine='Threaded Insert')
          and earlier.operation_number < o.operation_number
          and earlier.status is distinct from 'Complete'
      );

    -- Initialize the summary only when the sync has not supplied shop state.
    -- Existing requirement statuses, QC decisions, and notes remain untouched.
    if requirement.status is null then
      update manufacturing.requirements r set status=case
        when not exists (select 1 from manufacturing.operations o
          where o.requirement_id=r.id and o.active_in_routing and o.work_type='Manufacturing'
            and o.operation_number='OP1' and o.machine is distinct from 'Threaded Insert') then 'Needs Triage'
        when exists (select 1 from manufacturing.operations o
          where o.requirement_id=r.id and o.active_in_routing and o.status='In Progress'
            and o.work_type='Manufacturing') then 'On Machine'
        when exists (select 1 from manufacturing.operations o
          where o.requirement_id=r.id and o.active_in_routing and o.work_type='CAM'
            and o.status is distinct from 'Complete') then 'Ready for CAM'
        else 'Ready for Manufacturing' end,
        updated_at=clock_timestamp()
      where r.id=requirement.id;
    end if;
  end loop;
end;
$$;
revoke all on function manufacturing.initialize_synced_routing() from public, anon, authenticated, service_role;


commit;
