-- Apply after the printer_locations migration and 20260909_qc_rejected_quantities.sql.
-- Reuse requirement locations; claim/completion and movement commit together.
begin;

alter table manufacturing.requirements drop constraint requirements_part_location_check;
alter table manufacturing.requirements add constraint requirements_part_location_check
check (part_location is null or part_location in (
  'Clarke 1','Clarke 2','Clarke 3','Clarke 4','Clarke 5','Clarke 6','Clarke 7','Clarke 8',
  'Kwolek 1-1','Kwolek 1-2','Kwolek 1-3','Kwolek 1-4','Kwolek 1-5','Kwolek 1-6','Kwolek 1-7','Kwolek 1-8',
  'Kwolek 2-1','Kwolek 2-2','Kwolek 2-3','Kwolek 2-4','Kwolek 2-5','Kwolek 2-6','Kwolek 2-7','Kwolek 2-8',
  'Hopper 1','Hopper 2','Hopper 3','Hopper 4','Hopper 5','Hopper 6','Hopper 7','Hopper 8',
  'Jemison 1-1','Jemison 1-2','Jemison 1-3','Jemison 1-4','Jemison 1-5','Jemison 1-6','Jemison 1-7','Jemison 1-8',
  'Jemison 2-1','Jemison 2-2','Jemison 2-3','Jemison 2-4','Jemison 2-5','Jemison 2-6','Jemison 2-7','Jemison 2-8',
  'Shelf 1','Shelf 2','Shelf 3','On Robot',
  'Bambu X1C #1','Bambu X1C #2','Bambu X1C #3','Bambu H2D','Bambu X1C Pit'
));

create or replace function public.manufacturing_commit_with_operation_location(
  p_request_id uuid, p_actor uuid, p_action text, p_expected text,
  p_changes jsonb, p_qc jsonb, p_result jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  prior manufacturing.write_requests;
  actor_name text;
  target_requirement_id bigint;
  before_row jsonb;
  after_row jsonb;
  committed_result jsonb;
begin
  set local lock_timeout = '5s';
  lock table manufacturing.write_control, manufacturing.write_requests,
    manufacturing.requirements, manufacturing.operations, manufacturing.finishing,
    manufacturing.operation_allocations, public.quality_control,
    manufacturing.quality_review_retractions in share row exclusive mode;

  if not exists(select 1 from manufacturing.write_control where enabled) then
    raise exception 'Supabase manufacturing writes are disabled' using errcode = '42501';
  end if;
  select display_name into actor_name from public.profiles where id = p_actor and approved for share;
  if actor_name is null then raise exception 'Approved actor required' using errcode = '42501'; end if;

  -- The location is part of p_result and therefore covered by the existing
  -- request fingerprint. A retry must not move parts back after a later move.
  select * into prior from manufacturing.write_requests where request_id = p_request_id;
  if found then
    if prior.payload_hash <> md5(jsonb_build_array(p_actor,p_action,p_expected,p_changes,p_qc,p_result)::text) then
      raise sqlstate 'PT409' using message = 'Request ID reused with different payload';
    end if;
    return prior.result;
  end if;

  if p_action is null or p_action not in ('claim','complete') or p_qc is not null
    or jsonb_typeof(p_result->'storageLocation') is distinct from 'string'
    or p_result->>'locationUpdatedAt' is null
    or p_result->>'locationUpdatedBy' is distinct from actor_name then
    raise exception 'Invalid operation location action';
  end if;
  if p_result->>'storageLocation' = 'On Robot' then
    raise sqlstate 'PT409' using message = 'Move parts onto the robot separately after QC and finishing';
  end if;

  target_requirement_id := (p_result->'notificationContext'->>'requirementId')::bigint;
  if not exists (
    select 1 from manufacturing.operations o
    where o.id = (p_result->>'id')::bigint and o.requirement_id = target_requirement_id
      and o.active_in_routing and o.work_type = 'Manufacturing'
      and (p_action = 'complete' or o.machine ~* '\m3d\s*print(er|ing)?\M')
      and exists(select 1 from jsonb_array_elements(p_changes) c
        where c->>'entity' = 'operations' and (c->>'id')::bigint = o.id)
  ) then
    raise exception 'Operation location target missing or unsupported';
  end if;

  committed_result := public.manufacturing_commit_with_qc_quantities(
    p_request_id, p_actor, p_action, p_expected, p_changes, p_qc, p_result
  );
  select to_jsonb(r) into before_row from manufacturing.requirements r where r.id = target_requirement_id;
  update manufacturing.requirements r
  set part_location = p_result->>'storageLocation', location_updated_by = actor_name,
      location_updated_at = (p_result->>'locationUpdatedAt')::timestamptz, updated_at = clock_timestamp()
  where r.id = target_requirement_id returning to_jsonb(r) into after_row;
  if not found then raise exception 'Part location target missing'; end if;
  -- Separate from the workflow's requirement history row in the same request.
  insert into manufacturing.write_history(request_id,entity,row_id,before_row,after_row)
  values(p_request_id,'part_locations',target_requirement_id,before_row,after_row);
  return committed_result;
end;
$$;

revoke all on function public.manufacturing_commit_with_operation_location(uuid,uuid,text,text,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.manufacturing_commit_with_operation_location(uuid,uuid,text,text,jsonb,jsonb,jsonb)
  to service_role;

commit;
