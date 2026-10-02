-- Staged Onshape sync review. Apply after the engineering-sync API
-- (supabase/production/20260906_onshape_engineering_sync.sql and its patches),
-- routing initialization, obsoletion, admin engineering overrides, and
-- notifications. A staged sync stores its payload here instead of committing
-- it. An approved administrator reviews it in the app, then approves (with
-- optional exclusions) or denies it. Approval commits through the unchanged
-- manufacturing_apply_engineering_sync in the same transaction, so overrides,
-- routing initialization, obsoletion, and stop-work alerts all run as before.
begin;

-- A staged run is no longer 'running', so shop writes made while a proposal
-- waits are never tracked as sync obsoletion candidates.
do $migration$
declare constraint_name text;
begin
  for constraint_name in
    select c.conname from pg_catalog.pg_constraint c
    where c.conrelid = 'manufacturing.engineering_sync_runs'::regclass and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%status%'
  loop
    execute format('alter table manufacturing.engineering_sync_runs drop constraint %I', constraint_name);
  end loop;
end;
$migration$;
alter table manufacturing.engineering_sync_runs add constraint engineering_sync_runs_status_check
  check (status in ('running','staged','success','partial','failed','denied','superseded'));

create table manufacturing.engineering_sync_proposals (
  run_id uuid primary key references manufacturing.engineering_sync_runs(id),
  status text not null default 'pending'
    check (status in ('pending','approved','denied','superseded','failed')),
  -- Exactly what the sync would have committed. Cleared 30 days after a decision.
  payload jsonb,
  details jsonb not null default '{}',
  summary jsonb not null default '{}',
  staged_at timestamptz not null default clock_timestamp(),
  decided_by uuid references auth.users(id),
  decided_by_name text,
  decided_at timestamptz,
  decision_note text not null default '' check (length(decision_note) <= 2000),
  exclusions jsonb not null default '[]',
  -- The change list the administrator decided on, kept after the payload is pruned.
  review jsonb,
  result jsonb,
  updated_at timestamptz not null default clock_timestamp()
);
create index engineering_sync_proposals_staged_idx on manufacturing.engineering_sync_proposals(staged_at desc);
alter table manufacturing.engineering_sync_proposals enable row level security;
revoke all on manufacturing.engineering_sync_proposals from public, anon, authenticated, service_role;

-- Called by the sync in place of manufacturing_apply_engineering_sync.
create function public.manufacturing_stage_engineering_sync(p_run_id uuid, p_payload jsonb, p_details jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  run manufacturing.engineering_sync_runs;
  entity text;
  superseded uuid[];
  run_summary jsonb;
  label text;
  roots_text text;
begin
  -- The same lock as engineering commits: staging never interleaves with an approval.
  perform pg_catalog.pg_advisory_xact_lock(190, 20260905);
  select * into run from manufacturing.engineering_sync_runs where id = p_run_id for update;
  if not found then raise exception 'Unknown engineering sync run'; end if;
  -- A retry after an uncertain response returns the existing proposal.
  if run.status = 'staged' and exists(select 1 from manufacturing.engineering_sync_proposals where run_id = p_run_id) then
    return jsonb_build_object('status', 'staged', 'proposal_id', p_run_id, 'superseded', '[]'::jsonb);
  end if;
  if run.status <> 'running' then raise exception 'Engineering sync run is already %', run.status; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'Invalid engineering payload'; end if;
  foreach entity in array array['assemblies','parts','requirements','operations','finishing','attachments',
    'warnings','synced_roots','discovered_roots'] loop
    if jsonb_typeof(p_payload->entity) is distinct from 'array' then
      raise exception 'Missing engineering array: %', entity;
    end if;
  end loop;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then p_details := '{}'::jsonb; end if;

  -- Each staged sync is computed from Onshape and the current database, so it
  -- replaces any proposal still waiting for a decision.
  with older as (
    update manufacturing.engineering_sync_proposals set status = 'superseded', updated_at = clock_timestamp()
    where status in ('pending','failed') returning run_id
  ) select coalesce(array_agg(run_id), '{}') into superseded from older;
  update manufacturing.engineering_sync_runs
  set status = 'superseded', summary = summary || jsonb_build_object('status', 'superseded', 'superseded_by', p_run_id)
  where id = any(superseded) and status = 'staged';

  run_summary := jsonb_build_object('status', 'staged', 'committed', false,
    'synced_roots', p_payload->'synced_roots', 'warnings', p_payload->'warnings',
    'counts', jsonb_build_object(
      'assemblies', jsonb_array_length(p_payload->'assemblies'), 'parts', jsonb_array_length(p_payload->'parts'),
      'requirements', jsonb_array_length(p_payload->'requirements'), 'operations', jsonb_array_length(p_payload->'operations'),
      'finishing', jsonb_array_length(p_payload->'finishing'), 'attachments', jsonb_array_length(p_payload->'attachments')));
  insert into manufacturing.engineering_sync_proposals(run_id, payload, details, summary)
  values (p_run_id, p_payload, p_details, run_summary);
  update manufacturing.engineering_sync_runs set status = 'staged', summary = run_summary, finished_at = clock_timestamp()
  where id = p_run_id;

  -- Payloads are large; the decision record (review) is kept.
  update manufacturing.engineering_sync_proposals set payload = null
  where payload is not null and status in ('approved','denied','superseded')
    and updated_at < clock_timestamp() - interval '30 days';

  -- Alert every approved administrator; retire alerts for replaced proposals.
  update public.notifications set read_at = clock_timestamp()
  where type = 'engineering_sync_review' and read_at is null and data->>'proposalId' = any(superseded::text[]);
  label := coalesce(nullif(btrim(p_details->>'label'), ''), 'The Onshape sync');
  select string_agg(value, ', ' order by value) into roots_text from jsonb_array_elements_text(p_payload->'synced_roots');
  insert into public.notifications(recipient_id, type, title, message, data)
  select profile.id, 'engineering_sync_review', 'Onshape sync ready for review',
    format('%s staged changes for %s. Nothing changes in the shop until an administrator approves it in Admin → Onshape sync.',
      label, coalesce('manufacturing roots ' || roots_text, 'Main membership')),
    jsonb_build_object('proposalId', p_run_id, 'href', '/admin/sync?proposal=' || p_run_id)
  from public.profiles profile
  where profile.approved and profile.role = 'admin';

  return jsonb_build_object('status', 'staged', 'proposal_id', p_run_id, 'superseded', to_jsonb(superseded));
end;
$$;

create function public.manufacturing_engineering_sync_proposals(p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(item order by staged_at desc), '[]'::jsonb) from (
    select p.staged_at, jsonb_build_object('id', p.run_id, 'status', p.status, 'stagedAt', p.staged_at,
      'startedAt', r.started_at, 'runUrl', r.github_run_url, 'details', p.details, 'summary', p.summary,
      'decidedBy', p.decided_by_name, 'decidedAt', p.decided_at, 'note', p.decision_note, 'result', p.result) item
    from manufacturing.engineering_sync_proposals p
    join manufacturing.engineering_sync_runs r on r.id = p.run_id
    order by p.staged_at desc
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ) s;
$$;

-- The proposal plus the current engineering rows it touches, read in one
-- snapshot. The app computes the change list and the approved payload from it.
create function public.manufacturing_engineering_sync_review_state(p_proposal_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  proposal manufacturing.engineering_sync_proposals;
  run manufacturing.engineering_sync_runs;
  roots text[]; keys text[]; operation_keys text[]; part_numbers text[]; assembly_numbers text[];
  requirement_ids bigint[]; part_ids bigint[];
  base jsonb;
begin
  select * into proposal from manufacturing.engineering_sync_proposals where run_id = p_proposal_id;
  if not found then return null; end if;
  select * into run from manufacturing.engineering_sync_runs where id = p_proposal_id;
  base := jsonb_build_object(
    'proposal', jsonb_build_object('id', proposal.run_id, 'status', proposal.status, 'stagedAt', proposal.staged_at,
      'startedAt', run.started_at, 'runUrl', run.github_run_url, 'details', proposal.details, 'summary', proposal.summary,
      'decidedBy', proposal.decided_by_name, 'decidedAt', proposal.decided_at, 'note', proposal.decision_note,
      'exclusions', proposal.exclusions, 'review', proposal.review, 'result', proposal.result),
    'payload', proposal.payload,
    -- The engineering commit refuses a run started before a newer commit.
    'stale', exists(select 1 from manufacturing.engineering_sync_runs other
      where other.id <> run.id and other.summary->>'committed' = 'true' and other.finished_at > run.started_at));
  if proposal.payload is null then return base; end if;

  roots := array(select jsonb_array_elements_text(proposal.payload->'synced_roots'));
  keys := array(select value->>'production_key' from jsonb_array_elements(proposal.payload->'requirements'));
  operation_keys := array(select value->>'operation_key' from jsonb_array_elements(proposal.payload->'operations'));
  part_numbers := array(select value->>'part_number' from jsonb_array_elements(proposal.payload->'parts')
    union select value->>'part_number' from jsonb_array_elements(proposal.payload->'attachments'));
  assembly_numbers := roots || array(select value->>'assembly_number' from jsonb_array_elements(proposal.payload->'assemblies'));

  -- Deactivation scope mirrors manufacturing_apply_engineering_sync.
  select coalesce(array_agg(r.id), '{}') into requirement_ids
  from manufacturing.requirements r left join manufacturing.assemblies a on a.id = r.assembly_id
  where r.production_key = any(keys)
    or coalesce(nullif(r.source_root,''), case when cardinality(string_to_array(r.production_key,'|'))>=5
      then split_part(r.production_key,'|',1) end, a.assembly_number) = any(roots);
  select coalesce(array_agg(distinct id), '{}') into part_ids from (
    select part_id id from manufacturing.requirements where id = any(requirement_ids)
    union select id from manufacturing.parts where part_number = any(part_numbers)) ids where id is not null;

  return base || jsonb_build_object(
    'assemblies', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'assembly_number', a.assembly_number,
        'subsystem_name', a.subsystem_name, 'latest_released_revision', a.latest_released_revision,
        'integration_status', a.integration_status, 'discovery_master', a.discovery_master, 'active', a.active) order by a.id)
      from manufacturing.assemblies a where a.assembly_number = any(assembly_numbers)
        or (coalesce(proposal.payload->>'discovery_master','') <> '' and a.discovery_master = proposal.payload->>'discovery_master')), '[]'::jsonb),
    'parts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'part_number', p.part_number, 'name', p.name,
        'description', p.description, 'material', p.material, 'manufacturing_method', p.manufacturing_method,
        'vendor', p.vendor, 'revision', p.revision, 'onshape_url', p.onshape_url, 'category', p.category,
        'drawing_url', p.drawing_url, 'active', p.active, 'cots', p.cots) order by p.id)
      from manufacturing.parts p where p.id = any(part_ids)), '[]'::jsonb),
    'requirements', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'production_key', r.production_key,
        'part_id', r.part_id, 'part_number', p.part_number, 'assembly_number', a.assembly_number,
        'scope_root', coalesce(nullif(r.source_root,''), case when cardinality(string_to_array(r.production_key,'|'))>=5
          then split_part(r.production_key,'|',1) end, a.assembly_number),
        'source_root', r.source_root, 'configuration', r.configuration, 'required_quantity', r.required_quantity,
        'bom_positions', r.bom_positions, 'onshape_url', r.onshape_url, 'source_document', r.source_document,
        'source_assembly_revision', r.source_assembly_revision, 'required_part_revision', r.required_part_revision,
        'machine_op1', r.machine_op1, 'machine_op2', r.machine_op2, 'machine_op3', r.machine_op3, 'machine_op4', r.machine_op4,
        'finishing', r.finishing, 'active_in_bom', r.active_in_bom, 'obsolete', r.obsolete, 'status', r.status,
        'qc_outcome', r.qc_outcome, 'part_location', r.part_location, 'off_the_shelf', r.off_the_shelf) order by r.id)
      from manufacturing.requirements r left join manufacturing.parts p on p.id = r.part_id
      left join manufacturing.assemblies a on a.id = r.assembly_id where r.id = any(requirement_ids)), '[]'::jsonb),
    'operations', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'requirement_id', o.requirement_id,
        'operation_key', o.operation_key, 'operation_number', o.operation_number, 'machine', o.machine,
        'work_type', o.work_type, 'active_in_routing', o.active_in_routing, 'status', o.status,
        'claimed_quantity', o.claimed_quantity, 'completed_quantity', o.completed_quantity) order by o.id)
      from manufacturing.operations o where o.requirement_id = any(requirement_ids) or o.operation_key = any(operation_keys)), '[]'::jsonb),
    'finishing', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'requirement_id', f.requirement_id,
        'production_key', f.production_key, 'color', f.color, 'required_quantity', f.required_quantity,
        'active', f.active, 'machinist', f.machinist) order by f.id)
      from manufacturing.finishing f where f.requirement_id = any(requirement_ids)), '[]'::jsonb),
    'overrides', coalesce((select jsonb_agg(jsonb_build_object('entity', o.entity, 'row_id', o.row_id, 'field', o.field,
        'value', o.value, 'synced_value', o.synced_value) order by o.id)
      from manufacturing.engineering_overrides o
      where (o.entity = 'parts' and o.row_id = any(part_ids)) or (o.entity = 'requirements' and o.row_id = any(requirement_ids))), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('part_id', f.part_id, 'kind', f.kind,
        'position', f.position, 'original_name', f.original_name) order by f.part_id, f.kind, f.position)
      from manufacturing.attachments f where f.part_id = any(part_ids)), '[]'::jsonb));
end;
$$;

-- Approve (commit the app-built payload through the unchanged engineering RPC)
-- or deny. The app derives p_payload from the staged payload, the exclusions,
-- and current rows; the engineering RPC still validates every row it receives.
create function public.manufacturing_decide_engineering_sync(
  p_proposal_id uuid, p_actor uuid, p_decision text, p_payload jsonb, p_exclusions jsonb, p_review jsonb, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  proposal manufacturing.engineering_sync_proposals;
  actor_name text;
  outcome jsonb;
  next_status text;
begin
  if p_decision is null or p_decision not in ('approve','deny') then raise exception 'Invalid engineering sync decision'; end if;
  if length(coalesce(p_note, '')) > 2000 then raise exception 'Decision note is too long'; end if;
  select display_name into actor_name from public.profiles where id = p_actor and approved and role = 'admin';
  if not found then raise exception 'Approved administrator required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(190, 20260905);
  select * into proposal from manufacturing.engineering_sync_proposals where run_id = p_proposal_id for update;
  if not found then raise sqlstate 'PT409' using message = 'This sync proposal no longer exists'; end if;
  if proposal.status not in ('pending','failed') then
    raise sqlstate 'PT409' using message = format('This sync was already %s', proposal.status);
  end if;
  if proposal.payload is null then raise sqlstate 'PT409' using message = 'This sync proposal has no payload'; end if;

  if p_decision = 'deny' then
    next_status := 'denied';
    outcome := jsonb_build_object('status', 'denied', 'committed', false);
    update manufacturing.engineering_sync_runs
    set status = 'denied', finished_at = clock_timestamp(),
      summary = summary || jsonb_build_object('status', 'denied', 'committed', false, 'decided_by', actor_name)
    where id = p_proposal_id and status in ('staged','failed');
  else
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' then raise exception 'Invalid engineering payload'; end if;
    -- Back to 'running' only inside this transaction; the engineering RPC
    -- finishes the run, and its status triggers fire as for a direct sync.
    update manufacturing.engineering_sync_runs set status = 'running'
    where id = p_proposal_id and status in ('staged','failed');
    if not found then raise sqlstate 'PT409' using message = 'This sync run can no longer be applied'; end if;
    outcome := public.manufacturing_apply_engineering_sync(p_proposal_id, p_payload);
    next_status := case when outcome->>'status' = 'failed' then 'failed' else 'approved' end;
  end if;

  update manufacturing.engineering_sync_proposals
  set status = next_status, decided_by = p_actor, decided_by_name = actor_name, decided_at = clock_timestamp(),
    decision_note = coalesce(p_note, ''), exclusions = coalesce(p_exclusions, '[]'::jsonb), review = p_review,
    result = outcome, updated_at = clock_timestamp()
  where run_id = p_proposal_id;
  if next_status <> 'failed' then
    update public.notifications set read_at = clock_timestamp()
    where type = 'engineering_sync_review' and read_at is null and data->>'proposalId' = p_proposal_id::text;
  end if;
  return outcome || jsonb_build_object('proposal_status', next_status);
end;
$$;

revoke all on function public.manufacturing_stage_engineering_sync(uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.manufacturing_stage_engineering_sync(uuid,jsonb,jsonb) to service_role;
revoke all on function public.manufacturing_engineering_sync_proposals(integer) from public, anon, authenticated;
grant execute on function public.manufacturing_engineering_sync_proposals(integer) to service_role;
revoke all on function public.manufacturing_engineering_sync_review_state(uuid) from public, anon, authenticated;
grant execute on function public.manufacturing_engineering_sync_review_state(uuid) to service_role;
revoke all on function public.manufacturing_decide_engineering_sync(uuid,uuid,text,jsonb,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.manufacturing_decide_engineering_sync(uuid,uuid,text,jsonb,jsonb,jsonb,text) to service_role;

commit;
