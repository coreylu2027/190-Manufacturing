-- Apply after 20260905_qc_storage_locations.sql. Part location is independent
-- from QC; the guarded On Robot location still requires an effective QC pass
-- and no outstanding finishing work.
begin;

alter table manufacturing.requirements
  add column if not exists part_location text,
  add column if not exists location_updated_by text,
  add column if not exists location_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'requirements_part_location_check'
      and conrelid = 'manufacturing.requirements'::regclass
  ) then
    alter table manufacturing.requirements
      add constraint requirements_part_location_check check (part_location is null or part_location in (
        'Clarke 1','Clarke 2','Clarke 3','Clarke 4','Clarke 5','Clarke 6','Clarke 7','Clarke 8',
        'Kwolek 1-1','Kwolek 1-2','Kwolek 1-3','Kwolek 1-4','Kwolek 1-5','Kwolek 1-6','Kwolek 1-7','Kwolek 1-8',
        'Kwolek 2-1','Kwolek 2-2','Kwolek 2-3','Kwolek 2-4','Kwolek 2-5','Kwolek 2-6','Kwolek 2-7','Kwolek 2-8',
        'Hopper 1','Hopper 2','Hopper 3','Hopper 4','Hopper 5','Hopper 6','Hopper 7','Hopper 8',
        'Jemison 1-1','Jemison 1-2','Jemison 1-3','Jemison 1-4','Jemison 1-5','Jemison 1-6','Jemison 1-7','Jemison 1-8',
        'Jemison 2-1','Jemison 2-2','Jemison 2-3','Jemison 2-4','Jemison 2-5','Jemison 2-6','Jemison 2-7','Jemison 2-8',
        'Shelf 1','Shelf 2','Shelf 3','On Robot'
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'requirements_location_attribution_check'
      and conrelid = 'manufacturing.requirements'::regclass
  ) then
    alter table manufacturing.requirements
      add constraint requirements_location_attribution_check check (
        (location_updated_by is null) = (location_updated_at is null)
      );
  end if;
end $$;

-- Preserve the most recently recorded QC-era location as the initial part location.
with latest_location as (
  select distinct on (q.production_requirement_id)
    q.production_requirement_id,
    q.storage_location,
    coalesce(p.display_name, q.location_updated_by::text) as updated_by,
    q.location_updated_at
  from public.quality_control q
  left join public.profiles p on p.id = q.location_updated_by
  where q.production_requirement_id is not null
    and q.storage_location is not null
  order by q.production_requirement_id, q.reviewed_at desc, q.id desc
)
update manufacturing.requirements r
set part_location = l.storage_location,
    location_updated_by = l.updated_by,
    location_updated_at = l.location_updated_at
from latest_location l
where r.id = l.production_requirement_id
  and r.part_location is null;

create or replace function public.manufacturing_commit_with_locations(
  p_request_id uuid, p_actor uuid, p_action text, p_expected text,
  p_changes jsonb, p_qc jsonb, p_result jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  committed_result jsonb;
  prior manufacturing.write_requests;
  fingerprint text;
  actor_role text;
  actor_name text;
  target_requirement_id bigint;
  target_review_id bigint;
  review_result text;
  review_time timestamptz;
  before_row jsonb;
  after_row jsonb;
  requested_location text;
begin
  set local lock_timeout = '5s';
  lock table manufacturing.write_control, manufacturing.write_requests,
    manufacturing.requirements, manufacturing.operations, manufacturing.finishing,
    manufacturing.operation_allocations, public.quality_control,
    manufacturing.quality_review_retractions in share row exclusive mode;

  requested_location := p_qc->>'location';

  if p_action <> 'part_location' then
    if p_action = 'qc_review' and p_qc->>'result' = 'failed' and requested_location is not null then
      raise exception 'Failed QC cannot assign a location';
    end if;
    if p_action = 'qc_review' and requested_location = 'On Robot' then
      raise exception 'On Robot becomes available after QC passes and finishing is complete' using errcode='40001';
    end if;
    if p_action = 'qc_undo' and exists (
      select 1 from manufacturing.requirements r
      where r.id = (p_qc->>'requirement_id')::bigint and r.part_location = 'On Robot'
    ) then
      raise exception 'Move the part off the robot before undoing QC' using errcode='40001';
    end if;
    if p_action = 'finishing_undo_complete' and exists (
      select 1
      from jsonb_array_elements(p_changes) change
      join manufacturing.requirements r on r.id = (change->>'id')::bigint
      where change->>'entity' = 'requirements'
        and change->'patch'->>'status' = 'Ready for Finishing'
        and r.part_location = 'On Robot'
    ) then
      raise exception 'Move the part off the robot before reopening finishing' using errcode='40001';
    end if;

    committed_result := public.manufacturing_commit(
      p_request_id, p_actor, p_action, p_expected, p_changes, p_qc, p_result
    );

    if p_action = 'qc_review' and p_qc->>'result' = 'passed' and requested_location is not null then
      select display_name into actor_name from public.profiles where id = p_actor;
      update public.quality_control
      set storage_location = requested_location,
          location_updated_by = p_actor,
          location_updated_at = (p_qc->>'reviewed_at')::timestamptz,
          updated_at = clock_timestamp()
      where production_requirement_id = (p_qc->>'requirement_id')::bigint
        and reviewed_by = p_actor
        and reviewed_at = (p_qc->>'reviewed_at')::timestamptz
        and result = 'passed';
      if not found then raise exception 'QC review location target missing' using errcode='40001'; end if;

      update manufacturing.requirements
      set part_location = requested_location,
          location_updated_by = actor_name,
          location_updated_at = (p_qc->>'reviewed_at')::timestamptz,
          updated_at = clock_timestamp()
      where id = (p_qc->>'requirement_id')::bigint;
      if not found then raise exception 'Part location target missing' using errcode='40001'; end if;
    elsif p_action = 'qc_undo' then
      select q.id into target_review_id
      from public.quality_control q
      where q.production_requirement_id = (p_qc->>'requirement_id')::bigint
         or (q.production_requirement_id is null and exists (
           select 1 from manufacturing.operations o
           where o.id = q.operation_id and o.requirement_id = (p_qc->>'requirement_id')::bigint
         ))
      order by q.reviewed_at desc, q.id desc limit 1;
      update public.quality_control
      set storage_location = null, location_updated_by = null,
          location_updated_at = null, updated_at = clock_timestamp()
      where id = target_review_id;
    end if;

    return committed_result;
  end if;

  if not exists(select 1 from manufacturing.write_control where enabled) then
    raise exception 'Supabase manufacturing writes are disabled' using errcode = '42501';
  end if;
  select role::text, display_name into actor_role, actor_name
  from public.profiles where id = p_actor and approved for share;
  if actor_role is null then raise exception 'Approved actor required' using errcode = '42501'; end if;
  if p_qc is null or jsonb_typeof(p_changes) is distinct from 'array'
    or jsonb_array_length(p_changes) <> 0 or p_qc->>'location_updated_at' is null then
    raise exception 'Invalid part location action';
  end if;

  fingerprint := md5(jsonb_build_array(p_actor,p_action,p_expected,p_changes,p_qc,p_result)::text);
  select * into prior from manufacturing.write_requests where request_id = p_request_id;
  if found then
    if prior.payload_hash <> fingerprint then
      raise exception 'Request ID reused with different payload' using errcode='40001';
    end if;
    return prior.result;
  end if;

  if p_expected is distinct from md5(manufacturing.write_snapshot()::text) then
    raise exception 'Manufacturing state changed' using errcode='40001';
  end if;

  target_requirement_id := (p_qc->>'requirement_id')::bigint;
  select to_jsonb(r) into before_row
  from manufacturing.requirements r where r.id = target_requirement_id;
  if before_row is null then raise exception 'Part location target missing' using errcode='40001'; end if;

  if requested_location = 'On Robot' then
    select q.id, q.result::text, q.reviewed_at
      into target_review_id, review_result, review_time
    from public.quality_control q
    where q.production_requirement_id = target_requirement_id
       or (q.production_requirement_id is null and exists (
         select 1 from manufacturing.operations o
         where o.id = q.operation_id and o.requirement_id = target_requirement_id
       ))
    order by q.reviewed_at desc, q.id desc limit 1;

    if review_result is distinct from 'passed'
      or exists(select 1 from manufacturing.quality_review_retractions r where r.review_id = target_review_id)
      or (before_row->>'qc_outcome') is distinct from 'Passed'
      or not exists(select 1 from (
        select distinct on (coalesce(nullif(o.operation_key,''),'row:'||o.id::text)) o.status,o.completed_at
        from manufacturing.operations o
        where o.requirement_id = target_requirement_id and o.active_in_routing
          and o.work_type = 'Manufacturing' and lower(trim(coalesce(o.machine,''))) <> 'threaded insert'
        order by coalesce(nullif(o.operation_key,''),'row:'||o.id::text),
          o.completed_quantity desc,o.claimed_quantity desc,(o.completed_at is not null) desc,
          (o.started_at is not null) desc,
          case o.status when 'Needs Rework' then 5 when 'Complete' then 4 when 'In Progress' then 3
            when 'Blocked' then 2 when 'Ready' then 1 else 0 end desc,o.id
      ) canonical)
      or exists(select 1 from (
        select distinct on (coalesce(nullif(o.operation_key,''),'row:'||o.id::text)) o.status,o.completed_at
        from manufacturing.operations o
        where o.requirement_id = target_requirement_id and o.active_in_routing
          and o.work_type = 'Manufacturing' and lower(trim(coalesce(o.machine,''))) <> 'threaded insert'
        order by coalesce(nullif(o.operation_key,''),'row:'||o.id::text),
          o.completed_quantity desc,o.claimed_quantity desc,(o.completed_at is not null) desc,
          (o.started_at is not null) desc,
          case o.status when 'Needs Rework' then 5 when 'Complete' then 4 when 'In Progress' then 3
            when 'Blocked' then 2 when 'Ready' then 1 else 0 end desc,o.id
      ) canonical where canonical.status is distinct from 'Complete' or canonical.completed_at > review_time)
      or (coalesce(before_row->>'finishing','None') not in ('','None')
        and coalesce(before_row->>'status','Needs Triage') in ('Ready for QC','Ready for Finishing','Needs Rework')) then
      raise exception 'On Robot requires passed QC and completed finishing' using errcode='40001';
    end if;
  end if;

  insert into manufacturing.write_requests(request_id,actor,action,payload_hash,result)
  values(p_request_id,p_actor,p_action,fingerprint,p_result);
  update manufacturing.requirements as r
  set part_location = requested_location,
      location_updated_by = actor_name,
      location_updated_at = (p_qc->>'location_updated_at')::timestamptz,
      updated_at = clock_timestamp()
  where id = target_requirement_id
  returning to_jsonb(r) into after_row;
  insert into manufacturing.write_history(request_id,entity,row_id,before_row,after_row)
  values(p_request_id,'requirements',target_requirement_id,before_row,after_row);
  return p_result;
end;
$$;

revoke all on function public.manufacturing_commit_with_locations(uuid,uuid,text,text,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.manufacturing_commit_with_locations(uuid,uuid,text,text,jsonb,jsonb,jsonb)
  to service_role;

commit;
