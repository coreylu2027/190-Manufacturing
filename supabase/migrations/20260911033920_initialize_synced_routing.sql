-- Apply after the Onshape engineering-sync API and normalized production schema.
-- Engineering inserts intentionally omit shop fields. Initialize only new,
-- untouched routes; never reset an existing status, claim, or completed task.
begin;

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
    where r.active_in_bom and (r.status is null or exists (
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

create or replace function manufacturing.initialize_routing_after_engineering_sync()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  perform manufacturing.initialize_synced_routing();
  return new;
end;
$$;
revoke all on function manufacturing.initialize_routing_after_engineering_sync() from public, anon, authenticated, service_role;

-- Runs in the engineering API's existing privileged transaction. No new
-- public RPC or client grants; failed syncs never initialize routes.
create trigger initialize_routing_after_engineering_sync
  after update of status on manufacturing.engineering_sync_runs
  for each row when (old.status='running' and new.status in ('success','partial'))
  execute function manufacturing.initialize_routing_after_engineering_sync();

select manufacturing.initialize_synced_routing();
commit;
