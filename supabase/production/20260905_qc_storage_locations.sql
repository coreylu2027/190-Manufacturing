-- Apply after the numbered Supabase migrations and
-- 20260905_manufacturing_writes.sql. This wrapper keeps existing production
-- installations upgradeable without recreating the write subsystem.
begin;

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
  target_requirement_id bigint;
  target_review_id bigint;
  review_result text;
  review_time timestamptz;
begin
  set local lock_timeout = '5s';
  lock table manufacturing.write_control, manufacturing.write_requests,
    manufacturing.requirements, manufacturing.operations, manufacturing.finishing,
    manufacturing.operation_allocations, public.quality_control,
    manufacturing.quality_review_retractions in share row exclusive mode;

  fingerprint := md5(jsonb_build_array(p_actor,p_action,p_expected,p_changes,p_qc,p_result)::text);
  select * into prior from manufacturing.write_requests where request_id = p_request_id;
  if found then
    if prior.payload_hash <> fingerprint then
      raise exception 'Request ID reused with different payload' using errcode='40001';
    end if;
    return prior.result;
  end if;

  if p_action <> 'qc_location' then
    if p_action = 'qc_review' and p_qc->>'result' = 'failed' and p_qc->>'location' is not null then
      raise exception 'Failed QC cannot assign a location';
    end if;

    committed_result := public.manufacturing_commit(
      p_request_id, p_actor, p_action, p_expected, p_changes, p_qc, p_result
    );

    if p_action = 'qc_review' and p_qc->>'result' = 'passed' and p_qc->>'location' is not null then
      update public.quality_control
      set storage_location = p_qc->>'location',
          location_updated_by = p_actor,
          location_updated_at = (p_qc->>'reviewed_at')::timestamptz,
          updated_at = clock_timestamp()
      where production_requirement_id = (p_qc->>'requirement_id')::bigint
        and reviewed_by = p_actor
        and reviewed_at = (p_qc->>'reviewed_at')::timestamptz
        and result = 'passed';
      if not found then raise exception 'QC review location target missing' using errcode='40001'; end if;
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
  select role::text into actor_role from public.profiles where id = p_actor and approved for share;
  if actor_role is null then raise exception 'Approved actor required' using errcode = '42501'; end if;
  if p_qc is null or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) <> 0 then
    raise exception 'Invalid QC location action';
  end if;
  if p_qc->>'location_updated_at' is null then raise exception 'Location update time required'; end if;

  if p_expected is distinct from md5(manufacturing.write_snapshot()::text) then
    raise exception 'Manufacturing state changed' using errcode='40001';
  end if;

  target_requirement_id := (p_qc->>'requirement_id')::bigint;
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
    or not exists(select 1 from (
      select distinct on (coalesce(nullif(o.operation_key,''),'row:'||o.id::text)) o.status,o.completed_at
      from manufacturing.operations o
      where o.requirement_id = target_requirement_id and o.active_in_routing and o.work_type = 'Manufacturing'
      order by coalesce(nullif(o.operation_key,''),'row:'||o.id::text),
        o.completed_quantity desc,o.claimed_quantity desc,(o.completed_at is not null) desc,
        (o.started_at is not null) desc,
        case o.status when 'Needs Rework' then 5 when 'Complete' then 4 when 'In Progress' then 3
          when 'Blocked' then 2 when 'Ready' then 1 else 0 end desc,o.id
    ) canonical)
    or exists(select 1 from (
      select distinct on (coalesce(nullif(o.operation_key,''),'row:'||o.id::text)) o.status,o.completed_at
      from manufacturing.operations o
      where o.requirement_id = target_requirement_id and o.active_in_routing and o.work_type = 'Manufacturing'
      order by coalesce(nullif(o.operation_key,''),'row:'||o.id::text),
        o.completed_quantity desc,o.claimed_quantity desc,(o.completed_at is not null) desc,
        (o.started_at is not null) desc,
        case o.status when 'Needs Rework' then 5 when 'Complete' then 4 when 'In Progress' then 3
          when 'Blocked' then 2 when 'Ready' then 1 else 0 end desc,o.id
    ) canonical where canonical.status is distinct from 'Complete' or canonical.completed_at > review_time) then
    raise exception 'A location can only be edited for the latest effective passed QC review' using errcode='40001';
  end if;

  insert into manufacturing.write_requests(request_id,actor,action,payload_hash,result)
  values(p_request_id,p_actor,p_action,fingerprint,p_result);
  update public.quality_control
  set storage_location = p_qc->>'location', location_updated_by = p_actor,
      location_updated_at = (p_qc->>'location_updated_at')::timestamptz,
      updated_at = clock_timestamp()
  where id = target_review_id;
  return p_result;
end;
$$;

revoke all on function public.manufacturing_commit_with_locations(uuid,uuid,text,text,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.manufacturing_commit_with_locations(uuid,uuid,text,text,jsonb,jsonb,jsonb)
  to service_role;

commit;
