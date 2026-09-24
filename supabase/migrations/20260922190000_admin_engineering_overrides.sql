-- Administrator corrections to Onshape-synced engineering data.
-- Apply after the engineering-sync API, routing initializer, assembly previews,
-- obsoletion, and visibility migrations. Overrides are stored separately and re-applied inside
-- each successful sync transaction, so the sync keeps validating and writing its
-- own values while the shop continues to see the corrected ones.
begin;

-- Bought rather than made. Onshape has no such field, so the sync never writes it;
-- its effect on routing and finishing is re-applied after each sync.
alter table manufacturing.requirements
  add column off_the_shelf boolean not null default false,
  add column off_the_shelf_changed_by text,
  add column off_the_shelf_changed_at timestamptz;

create table manufacturing.engineering_overrides (
  id bigint generated always as identity primary key,
  entity text not null,
  row_id bigint not null,
  field text not null,
  value jsonb not null,
  -- The most recent value delivered by the engineering sync for this field.
  synced_value jsonb not null,
  synced_at timestamptz,
  reason text not null default '' check (length(reason) <= 1000),
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null references auth.users(id),
  updated_by_name text not null,
  updated_at timestamptz not null default clock_timestamp(),
  unique (entity, row_id, field),
  constraint engineering_override_field check (
    (entity = 'parts' and field in ('material','name','description'))
    or (entity = 'requirements' and field in (
      'required_quantity','finishing','machine_op1','machine_op2','machine_op3','machine_op4'))
  )
);

-- Replacement files are part-level, like the synced catalog, but live outside
-- manufacturing.attachments because the sync rewrites those positions.
create table manufacturing.attachment_overrides (
  id bigint generated always as identity primary key,
  part_id bigint not null references manufacturing.parts(id) on delete restrict,
  kind text not null check (kind in ('drawing-pdf','step')),
  original_name text not null check (btrim(original_name) <> '' and length(original_name) <= 240),
  content_type text not null,
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_bucket text not null check (storage_bucket = 'manufacturing-files'),
  storage_path text not null,
  reason text not null default '' check (length(reason) <= 1000),
  updated_by uuid not null references auth.users(id),
  updated_by_name text not null,
  updated_at timestamptz not null default clock_timestamp(),
  unique (part_id, kind),
  check (content_type = case kind when 'drawing-pdf' then 'application/pdf' else 'application/step' end),
  check (storage_path = 'sha256/' || left(sha256, 2) || '/' || sha256
    || case kind when 'drawing-pdf' then '.pdf' else '.step' end)
);

create table manufacturing.engineering_override_events (
  id bigint generated always as identity primary key,
  request_id uuid references manufacturing.write_requests(request_id),
  entity text not null,
  row_id bigint not null,
  field text not null,
  action text not null check (action in ('set','cleared','retired')),
  value jsonb,
  synced_value jsonb,
  reason text,
  actor uuid,
  actor_name text not null,
  at timestamptz not null default clock_timestamp()
);
create index engineering_override_events_row_idx on manufacturing.engineering_override_events(entity, row_id, at);

alter table manufacturing.engineering_overrides enable row level security;
alter table manufacturing.attachment_overrides enable row level security;
alter table manufacturing.engineering_override_events enable row level security;
revoke all on manufacturing.engineering_overrides, manufacturing.attachment_overrides,
  manufacturing.engineering_override_events from public, anon, authenticated, service_role;
revoke all on sequence manufacturing.engineering_overrides_id_seq, manufacturing.attachment_overrides_id_seq,
  manufacturing.engineering_override_events_id_seq from public, anon, authenticated, service_role;
create trigger immutable before update or delete or truncate on manufacturing.engineering_override_events
  for each statement execute function manufacturing.prevent_history_change();

-- GLB previews for replacement STEPs, generated offline like synced previews.
create table manufacturing.override_part_previews (
  id bigint generated always as identity primary key,
  override_id bigint not null unique references manufacturing.attachment_overrides(id) on delete cascade,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  generator text not null check (generator <> ''),
  generator_version text not null check (generator_version <> ''),
  content_type text not null check (content_type = 'model/gltf-binary'),
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_bucket text not null check (storage_bucket = 'manufacturing-files'),
  storage_path text not null check (storage_path = 'sha256/' || left(sha256, 2) || '/' || sha256 || '.glb'),
  verified_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table manufacturing.override_part_previews enable row level security;
revoke all on manufacturing.override_part_previews from public, anon, authenticated, service_role;
revoke all on sequence manufacturing.override_part_previews_id_seq from public, anon, authenticated, service_role;

-- Existing clients refresh on any manufacturing change; overrides affect the projection too.
create trigger broadcast_manufacturing_change after insert or update or delete on manufacturing.engineering_overrides
  for each statement execute function manufacturing.broadcast_change();
create trigger broadcast_manufacturing_change after insert or update or delete on manufacturing.attachment_overrides
  for each statement execute function manufacturing.broadcast_change();

create function manufacturing.valid_override_value(p_field text, p_value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case
    when p_field = 'material' then p_value = 'null'::jsonb or (jsonb_typeof(p_value) = 'string'
      and btrim(p_value #>> '{}') = p_value #>> '{}' and p_value #>> '{}' <> '' and length(p_value #>> '{}') <= 200)
    when p_field = 'name' then jsonb_typeof(p_value) = 'string'
      and btrim(p_value #>> '{}') = p_value #>> '{}' and p_value #>> '{}' <> '' and length(p_value #>> '{}') <= 200
    when p_field = 'description' then p_value = 'null'::jsonb or (jsonb_typeof(p_value) = 'string'
      and btrim(p_value #>> '{}') = p_value #>> '{}' and p_value #>> '{}' <> '' and length(p_value #>> '{}') <= 2000)
    when p_field = 'required_quantity' then jsonb_typeof(p_value) = 'number'
      and (p_value #>> '{}')::numeric between 1 and 10000
      and trunc((p_value #>> '{}')::numeric) = (p_value #>> '{}')::numeric
    when p_field = 'finishing' then p_value in ('"None"'::jsonb, '"Red"'::jsonb, '"Black"'::jsonb)
    when p_field in ('machine_op1','machine_op2','machine_op3','machine_op4') then p_value = 'null'::jsonb
      or (jsonb_typeof(p_value) = 'string' and p_value #>> '{}' in ('Haas CNC','Shop Sabre CNC','Milling Machine','Lathe',
        'Markforged 3D Printer','Bambu 3D Printer','Bandsaw','Sander','Drill Press','COTS','FormLabs SLA','FormLabs SLS',
        'Countersinking','Threaded Insert','Tapping','Guided Drilling','Bending','Bridgeport'))
    else false end, false);
$$;
revoke all on function manufacturing.valid_override_value(text,jsonb) from public, anon, authenticated, service_role;

-- Everything an administrator sees before editing. Its md5 is the CAS token.
create function manufacturing.engineering_override_state(p_requirement_id bigint) returns jsonb
language sql stable set search_path = '' as $$
  with r as (select * from manufacturing.requirements where id = p_requirement_id),
  p as (select part.* from manufacturing.parts part join r on part.id = r.part_id)
  select jsonb_build_object(
    'requirement', (select jsonb_build_object('id', id, 'production_key', production_key, 'part_id', part_id,
      'required_quantity', required_quantity, 'finishing', finishing, 'machine_op1', machine_op1,
      'machine_op2', machine_op2, 'machine_op3', machine_op3, 'machine_op4', machine_op4,
      'active_in_bom', active_in_bom, 'obsolete', obsolete, 'off_the_shelf', off_the_shelf,
      'off_the_shelf_changed_by', off_the_shelf_changed_by, 'off_the_shelf_changed_at', off_the_shelf_changed_at) from r),
    'part', (select jsonb_build_object('id', id, 'part_number', part_number, 'name', name,
      'description', description, 'material', material) from p),
    'overrides', coalesce((select jsonb_agg(jsonb_build_object('entity', o.entity, 'row_id', o.row_id, 'field', o.field,
        'value', o.value, 'synced_value', o.synced_value, 'synced_at', o.synced_at, 'reason', o.reason,
        'updated_by_name', o.updated_by_name, 'updated_at', o.updated_at) order by o.entity, o.field)
      from manufacturing.engineering_overrides o
      where (o.entity = 'requirements' and o.row_id = p_requirement_id)
         or (o.entity = 'parts' and o.row_id = (select id from p))), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'name', a.original_name,
        'sha256', a.sha256, 'byte_size', a.byte_size) order by a.kind)
      from (select distinct on (kind) * from manufacturing.attachments
        where part_id = (select id from p) order by kind, position, id) a), '[]'::jsonb),
    'file_overrides', coalesce((select jsonb_agg(jsonb_build_object('kind', f.kind, 'name', f.original_name,
        'sha256', f.sha256, 'byte_size', f.byte_size, 'reason', f.reason,
        'preview', exists(select 1 from manufacturing.override_part_previews v
          where v.override_id = f.id and v.source_sha256 = f.sha256),
        'updated_by_name', f.updated_by_name, 'updated_at', f.updated_at) order by f.kind)
      from manufacturing.attachment_overrides f where f.part_id = (select id from p)), '[]'::jsonb)
  );
$$;
revoke all on function manufacturing.engineering_override_state(bigint) from public, anon, authenticated, service_role;

create function public.manufacturing_engineering_override_state(p_requirement_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select state || jsonb_build_object('token', md5(state::text))
  from (select manufacturing.engineering_override_state(p_requirement_id) state) s;
$$;
revoke all on function public.manufacturing_engineering_override_state(bigint) from public, anon, authenticated;
grant execute on function public.manufacturing_engineering_override_state(bigint) to service_role;

-- Runs inside the engineering sync transaction after the sync has written and
-- validated its own values. The sync sends every managed field for each row it
-- stamps with last_synced_at, so that row's column is Onshape's current value:
-- it is retained as synced_value, and an override that now matches retires.
create function manufacturing.reapply_engineering_overrides(p_synced_since timestamptz) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  adjustment manufacturing.engineering_overrides; current_row jsonb; v_synced jsonb;
  r manufacturing.requirements; stage integer; desired text; stage_key text;
begin
  for adjustment in select * from manufacturing.engineering_overrides order by id for update loop
    execute format('select to_jsonb(t) from manufacturing.%I t where id=$1', adjustment.entity) into current_row using adjustment.row_id;
    continue when current_row is null;
    if (current_row->>'last_synced_at')::timestamptz >= p_synced_since then
      v_synced := current_row->adjustment.field;
      if v_synced = adjustment.value then
        delete from manufacturing.engineering_overrides where id = adjustment.id;
        insert into manufacturing.engineering_override_events(entity,row_id,field,action,value,synced_value,actor_name)
          values(adjustment.entity,adjustment.row_id,adjustment.field,'retired',adjustment.value,v_synced,'Engineering sync');
        continue;
      end if;
      if v_synced is distinct from adjustment.synced_value then
        update manufacturing.engineering_overrides set synced_value = v_synced, synced_at = clock_timestamp() where id = adjustment.id;
      end if;
    end if;
    if current_row->adjustment.field is distinct from adjustment.value then
      execute format('update manufacturing.%1$I t set %2$I=(jsonb_populate_record(null::manufacturing.%1$I, jsonb_build_object(%3$L, $1))).%2$I,
        updated_at=clock_timestamp() where id=$2', adjustment.entity, adjustment.field, adjustment.field) using adjustment.value, adjustment.row_id;
    end if;
  end loop;

  -- Keep dependent finishing and routing rows aligned with corrected requirements.
  for r in select q.* from manufacturing.requirements q
    where q.active_in_bom and not q.obsolete and not q.off_the_shelf and exists(select 1 from manufacturing.engineering_overrides o
      where o.entity = 'requirements' and o.row_id = q.id) order by q.id
  loop
    if exists(select 1 from manufacturing.engineering_overrides o where o.entity = 'requirements'
      and o.row_id = r.id and o.field in ('finishing','required_quantity')) then
      if r.finishing in ('Red','Black') then
        update manufacturing.finishing f set color = r.finishing, required_quantity = r.required_quantity,
          active = true, updated_at = clock_timestamp()
        where f.requirement_id = r.id
          and row(f.color, f.required_quantity, f.active) is distinct from row(r.finishing, r.required_quantity, true);
        if not exists(select 1 from manufacturing.finishing f where f.requirement_id = r.id) then
          insert into manufacturing.finishing(production_key, requirement_id, color, required_quantity, active)
            values(r.production_key, r.id, r.finishing, r.required_quantity, true);
        end if;
      else
        update manufacturing.finishing f set active = false, updated_at = clock_timestamp()
        where f.requirement_id = r.id and f.active;
      end if;
    end if;

    for stage in 1..4 loop
      continue when not exists(select 1 from manufacturing.engineering_overrides o
        where o.entity = 'requirements' and o.row_id = r.id and o.field = 'machine_op' || stage);
      desired := case stage when 1 then r.machine_op1 when 2 then r.machine_op2 when 3 then r.machine_op3 else r.machine_op4 end;
      stage_key := r.production_key || '|OP' || stage;
      if desired is null then
        update manufacturing.operations o set active_in_routing = false, updated_at = clock_timestamp()
        where o.requirement_id = r.id and o.work_type = 'Manufacturing' and o.operation_number = 'OP' || stage
          and o.active_in_routing;
      else
        update manufacturing.operations o set machine = desired, active_in_routing = true, updated_at = clock_timestamp()
        where o.requirement_id = r.id and o.operation_key = stage_key and o.work_type = 'Manufacturing'
          and (o.machine is distinct from desired or not coalesce(o.active_in_routing, false));
        -- A missing row starts uninitialized; the routing initializer runs next.
        if not exists(select 1 from manufacturing.operations o where o.requirement_id = r.id
          and o.operation_key = stage_key and o.work_type = 'Manufacturing') then
          insert into manufacturing.operations(operation_key, requirement_id, operation_number, machine, work_type, active_in_routing)
            values(stage_key, r.id, 'OP' || stage, desired, 'Manufacturing', true);
        end if;
      end if;
    end loop;
  end loop;

  -- Off-the-shelf parts keep no active routing or finishing, whatever the sync sent.
  update manufacturing.operations o set active_in_routing = false, updated_at = clock_timestamp()
  from manufacturing.requirements q
  where o.requirement_id = q.id and q.off_the_shelf and o.active_in_routing;
  update manufacturing.finishing f set active = false, updated_at = clock_timestamp()
  from manufacturing.requirements q
  where f.requirement_id = q.id and q.off_the_shelf and f.active;
end;
$$;
revoke all on function manufacturing.reapply_engineering_overrides(timestamptz) from public, anon, authenticated, service_role;

create function manufacturing.apply_engineering_overrides_after_sync() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform manufacturing.reapply_engineering_overrides(new.started_at);
  return new;
end;
$$;
revoke all on function manufacturing.apply_engineering_overrides_after_sync() from public, anon, authenticated, service_role;
-- Alphabetical trigger order runs this before routing initialization and obsoletion.
create trigger apply_engineering_overrides_after_sync after update of status on manufacturing.engineering_sync_runs
  for each row when (old.status = 'running' and new.status in ('success','partial'))
  execute function manufacturing.apply_engineering_overrides_after_sync();

-- The application plans workflow consequences; this RPC enforces scope,
-- column allowlists, shop-work preservation, and override/column agreement.
create function public.manufacturing_apply_engineering_overrides(
  p_request_id uuid, p_actor uuid, p_expected text, p_override_token text, p_requirement_id bigint,
  p_overrides jsonb, p_changes jsonb, p_inserts jsonb, p_reason text, p_result jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prior manufacturing.write_requests; fingerprint text; actor_name text; target manufacturing.requirements;
  item jsonb; v_entity text; v_row_id bigint; v_field text; patch jsonb; allowed text[]; assignments text;
  before_row jsonb; after_row jsonb; current_value jsonb; existing manufacturing.engineering_overrides;
  had_override boolean; cleared jsonb := '{}'::jsonb; new_row jsonb; inserted_id bigint; has_work boolean;
  routing_fields text[] := '{}'; finishing_touched boolean := false; stage integer; desired text;
  off_the_shelf_changed boolean := false;
begin
  set local lock_timeout = '5s';
  -- Serialize with the engineering sync, then take the shop-write locks in their usual order.
  perform pg_catalog.pg_advisory_xact_lock(190, 20260905);
  lock table manufacturing.write_control, manufacturing.write_requests, manufacturing.requirements,
    manufacturing.operations, manufacturing.finishing, manufacturing.parts, manufacturing.engineering_overrides,
    manufacturing.write_history in share row exclusive mode;
  if not exists(select 1 from manufacturing.write_control where enabled) then
    raise exception 'Supabase manufacturing writes are disabled' using errcode = '42501';
  end if;
  select display_name into actor_name from public.profiles where id = p_actor and approved and role = 'admin' for share;
  if not found then raise exception 'Approved administrator required' using errcode = '42501'; end if;
  if p_request_id is null or p_requirement_id is null
    or jsonb_typeof(p_overrides) is distinct from 'array' or jsonb_typeof(p_changes) is distinct from 'array'
    or jsonb_typeof(p_inserts) is distinct from 'array' or length(coalesce(p_reason, '')) > 1000
    or jsonb_array_length(p_overrides) + jsonb_array_length(p_changes) + jsonb_array_length(p_inserts) = 0 then
    raise exception 'Invalid engineering override request';
  end if;
  fingerprint := md5(jsonb_build_array(p_actor,p_expected,p_override_token,p_requirement_id,p_overrides,
    p_changes,p_inserts,p_reason,p_result)::text);
  select * into prior from manufacturing.write_requests where request_id = p_request_id;
  if found then
    if prior.payload_hash <> fingerprint then raise sqlstate 'PT409' using message = 'Request ID reused with different payload'; end if;
    return prior.result;
  end if;
  if p_expected is distinct from md5(manufacturing.write_snapshot()::text)
    or p_override_token is distinct from md5(manufacturing.engineering_override_state(p_requirement_id)::text) then
    raise sqlstate 'PT409' using message = 'Manufacturing state changed';
  end if;
  select * into target from manufacturing.requirements where id = p_requirement_id;
  if not found then raise sqlstate 'PT409' using message = 'Production requirement no longer exists'; end if;
  if exists(select 1 from jsonb_array_elements(p_overrides) i group by i->>'entity', i->>'row_id', i->>'field' having count(*) > 1)
    or exists(select 1 from jsonb_array_elements(p_changes) i group by i->>'entity', i->>'id' having count(*) > 1) then
    raise exception 'Invalid engineering override request';
  end if;
  insert into manufacturing.write_requests(request_id, actor, action, payload_hash, result)
    values(p_request_id, p_actor, 'engineering_override', fingerprint, p_result);

  for item in select value from jsonb_array_elements(p_overrides) loop
    v_entity := item->>'entity'; v_row_id := (item->>'row_id')::bigint; v_field := item->>'field';
    if not ((v_entity = 'requirements' and v_row_id = p_requirement_id and v_field in (
          'required_quantity','finishing','machine_op1','machine_op2','machine_op3','machine_op4'))
        or (v_entity = 'parts' and v_row_id = target.part_id and v_field in ('material','name','description')))
      or item->>'action' is null or item->>'action' not in ('set','clear') then
      raise exception 'Invalid engineering override';
    end if;
    if v_entity = 'requirements' and (target.obsolete or target.active_in_bom is distinct from true) then
      raise sqlstate 'PT409' using message = 'Only active, non-obsolete requirements can be corrected';
    end if;
    if v_field like 'machine_op%' then routing_fields := routing_fields || v_field; end if;
    finishing_touched := finishing_touched or v_field in ('finishing','required_quantity');
    execute format('select to_jsonb(t)->%L from manufacturing.%I t where id=$1', v_field, v_entity) into current_value using v_row_id;
    select * into existing from manufacturing.engineering_overrides o
      where o.entity = v_entity and o.row_id = v_row_id and o.field = v_field;
    had_override := found;
    if item->>'action' = 'set' then
      if not (item ? 'value') or not manufacturing.valid_override_value(v_field, item->'value') then
        raise exception 'Invalid engineering override value';
      end if;
      if item->'value' = (case when had_override then existing.synced_value else coalesce(current_value, 'null'::jsonb) end) then
        raise sqlstate 'PT409' using message = 'That value matches Onshape; revert the adjustment instead';
      end if;
      if had_override then
        update manufacturing.engineering_overrides set value = item->'value', reason = coalesce(p_reason, ''),
          updated_by = p_actor, updated_by_name = coalesce(actor_name, p_actor::text), updated_at = clock_timestamp()
        where id = existing.id;
      else
        insert into manufacturing.engineering_overrides(entity, row_id, field, value, synced_value, reason,
          created_by, created_by_name, updated_by, updated_by_name)
        values(v_entity, v_row_id, v_field, item->'value', coalesce(current_value, 'null'::jsonb), coalesce(p_reason, ''),
          p_actor, coalesce(actor_name, p_actor::text), p_actor, coalesce(actor_name, p_actor::text));
      end if;
      insert into manufacturing.engineering_override_events(request_id,entity,row_id,field,action,value,synced_value,reason,actor,actor_name)
        values(p_request_id, v_entity, v_row_id, v_field, 'set', item->'value',
          case when had_override then existing.synced_value else coalesce(current_value, 'null'::jsonb) end,
          coalesce(p_reason, ''), p_actor, coalesce(actor_name, p_actor::text));
    else
      if not had_override then raise sqlstate 'PT409' using message = 'This field is not adjusted'; end if;
      delete from manufacturing.engineering_overrides where id = existing.id;
      cleared := cleared || jsonb_build_object(v_entity || '|' || v_row_id || '|' || v_field, existing.synced_value);
      insert into manufacturing.engineering_override_events(request_id,entity,row_id,field,action,value,synced_value,reason,actor,actor_name)
        values(p_request_id, v_entity, v_row_id, v_field, 'cleared', existing.value, existing.synced_value,
          coalesce(p_reason, ''), p_actor, coalesce(actor_name, p_actor::text));
    end if;
  end loop;

  for item in select value from jsonb_array_elements(p_changes) loop
    v_entity := item->>'entity'; v_row_id := (item->>'id')::bigint; patch := item->'patch';
    allowed := case v_entity
      when 'requirements' then array['required_quantity','finishing','machine_op1','machine_op2','machine_op3','machine_op4','status','qc_outcome','off_the_shelf']
      when 'parts' then array['material','name','description']
      when 'operations' then array['machine','active_in_routing','status','completed_at']
      when 'finishing' then array['color','required_quantity','active'] else null end;
    if allowed is null or jsonb_typeof(patch) is distinct from 'object' or patch = '{}'::jsonb
      or exists(select 1 from jsonb_object_keys(patch) k where not k = any(allowed)) then
      raise exception 'Invalid engineering override change';
    end if;
    execute format('select to_jsonb(t) from manufacturing.%I t where id=$1', v_entity) into before_row using v_row_id;
    if before_row is null then raise sqlstate 'PT409' using message = 'Manufacturing row missing'; end if;
    if (v_entity = 'requirements' and v_row_id <> p_requirement_id)
      or (v_entity = 'parts' and v_row_id is distinct from target.part_id)
      or (v_entity in ('operations','finishing') and (before_row->>'requirement_id')::bigint is distinct from p_requirement_id) then
      raise exception 'Engineering override changes must stay within one requirement';
    end if;
    if (v_entity = 'requirements' and patch ? 'qc_outcome' and patch->>'qc_outcome' is distinct from 'Not Inspected')
      or (patch ? 'status' and v_entity = 'operations' and patch->>'status' not in ('Planned','Ready','In Progress','Complete'))
      or (v_entity = 'operations' and patch ? 'machine' and not (patch->'machine' <> 'null'::jsonb
        and manufacturing.valid_override_value('machine_op1', patch->'machine')))
      or (v_entity = 'finishing' and patch ? 'color' and patch->>'color' not in ('Red','Black'))
      or (patch ? 'off_the_shelf' and (jsonb_typeof(patch->'off_the_shelf') is distinct from 'boolean'
        or patch->'off_the_shelf' = before_row->'off_the_shelf')) then
      raise exception 'Invalid engineering override change';
    end if;
    if patch ? 'off_the_shelf' then
      if target.obsolete or target.active_in_bom is distinct from true then
        raise sqlstate 'PT409' using message = 'Only active, non-obsolete requirements can be corrected';
      end if;
      off_the_shelf_changed := true;
      patch := patch || jsonb_build_object('off_the_shelf_changed_by', coalesce(actor_name, p_actor::text),
        'off_the_shelf_changed_at', clock_timestamp());
      insert into manufacturing.engineering_override_events(request_id,entity,row_id,field,action,value,reason,actor,actor_name)
        values(p_request_id, 'requirements', v_row_id, 'off_the_shelf',
          case when (patch->>'off_the_shelf')::boolean then 'set' else 'cleared' end, patch->'off_the_shelf',
          coalesce(p_reason, ''), p_actor, coalesce(actor_name, p_actor::text));
    end if;
    if v_entity = 'operations' then
      -- Rerouting never discards shop work. Completed CAM may be retired with its history.
      has_work := coalesce((before_row->>'claimed_quantity')::numeric, 0) > 0
        or coalesce((before_row->>'completed_quantity')::numeric, 0) > 0
        or before_row->>'status' in ('In Progress','Complete');
      if (patch ? 'machine' and patch->>'machine' is distinct from before_row->>'machine' and has_work)
        or (patch ? 'active_in_routing' and (patch->>'active_in_routing')::boolean is false
          and coalesce((before_row->>'active_in_routing')::boolean, false)
          and (coalesce((before_row->>'claimed_quantity')::numeric, 0) > 0
            or (before_row->>'work_type' is distinct from 'CAM' and has_work))) then
        raise sqlstate 'PT409' using message = 'Operations with recorded work cannot be rerouted';
      end if;
    end if;
    select string_agg(format('%1$I = (jsonb_populate_record(null::manufacturing.%2$I, $1)).%1$I', k, v_entity), ', ' order by k)
      into assignments from jsonb_object_keys(patch) k;
    execute format('update manufacturing.%1$I set %2$s, updated_at=clock_timestamp() where id=$2 returning to_jsonb(%1$I.*)',
      v_entity, assignments) into after_row using patch, v_row_id;
    insert into manufacturing.write_history(request_id, entity, row_id, before_row, after_row)
      values(p_request_id, v_entity, v_row_id, before_row, after_row);
    if v_entity in ('requirements','parts') then
      for v_field in select k from jsonb_object_keys(patch) k
          where k not in ('status','qc_outcome','off_the_shelf','off_the_shelf_changed_by','off_the_shelf_changed_at') loop
        if not exists(select 1 from manufacturing.engineering_overrides o where o.entity = v_entity
            and o.row_id = v_row_id and o.field = v_field)
          and not cleared ? (v_entity || '|' || v_row_id || '|' || v_field) then
          raise exception 'Engineering columns can only change through an override';
        end if;
      end loop;
      routing_fields := routing_fields || array(select k from jsonb_object_keys(patch) k where k like 'machine_op%');
      finishing_touched := finishing_touched or patch ?| array['finishing','required_quantity'];
    end if;
  end loop;

  for item in select value from jsonb_array_elements(p_inserts) loop
    new_row := item->'row';
    if jsonb_typeof(new_row) is distinct from 'object' then raise exception 'Invalid engineering override insert'; end if;
    select * into target from manufacturing.requirements where id = p_requirement_id;
    if item->>'entity' = 'operations' then
      if exists(select 1 from jsonb_object_keys(new_row) k where not k = any(array['operation_key','requirement_id',
          'operation_number','machine','work_type','active_in_routing','status','claimed_quantity','completed_quantity','quantity_ledger']))
        or (new_row->>'requirement_id')::bigint is distinct from p_requirement_id
        or coalesce(new_row->>'operation_number', '') not in ('OP1','OP2','OP3','OP4')
        or coalesce(new_row->>'work_type', '') not in ('Manufacturing','CAM')
        or new_row->'machine' is null or new_row->'machine' = 'null'::jsonb
        or not manufacturing.valid_override_value('machine_op1', new_row->'machine')
        or (new_row->>'work_type' = 'CAM' and new_row->>'machine' not in ('Haas CNC','Shop Sabre CNC'))
        or new_row->>'operation_key' is distinct from (target.production_key
          || (case when new_row->>'work_type' = 'CAM' then '|CAM|' else '|' end) || (new_row->>'operation_number'))
        or (new_row->>'active_in_routing')::boolean is not true
        or coalesce(new_row->>'status', '') not in ('Planned','Ready')
        or (new_row->>'claimed_quantity')::numeric is distinct from 0
        or (new_row->>'completed_quantity')::numeric is distinct from 0
        or new_row->>'quantity_ledger' is distinct from '[]' then
        raise exception 'Invalid operation insert';
      end if;
      -- Manufacturing keys are matched by the sync, so never duplicate one.
      if exists(select 1 from manufacturing.operations o where o.operation_key = new_row->>'operation_key'
          and (new_row->>'work_type' = 'Manufacturing' or o.active_in_routing)) then
        raise sqlstate 'PT409' using message = 'That operation already exists';
      end if;
      insert into manufacturing.operations(operation_key, requirement_id, operation_number, machine, work_type,
        active_in_routing, status, claimed_quantity, completed_quantity, quantity_ledger)
      select operation_key, requirement_id, operation_number, machine, work_type, active_in_routing, status,
        claimed_quantity, completed_quantity, quantity_ledger
      from jsonb_populate_record(null::manufacturing.operations, new_row)
      returning id into inserted_id;
      select to_jsonb(o) into after_row from manufacturing.operations o where o.id = inserted_id;
      insert into manufacturing.write_history(request_id, entity, row_id, before_row, after_row)
        values(p_request_id, 'operations', inserted_id, '{}'::jsonb, after_row);
    elsif item->>'entity' = 'finishing' then
      if exists(select 1 from jsonb_object_keys(new_row) k where not k = any(array['production_key','requirement_id',
          'color','required_quantity','active']))
        or (new_row->>'requirement_id')::bigint is distinct from p_requirement_id
        or new_row->>'production_key' is distinct from target.production_key
        or coalesce(new_row->>'color', '') not in ('Red','Black')
        or (new_row->>'active')::boolean is not true then
        raise exception 'Invalid finishing insert';
      end if;
      if exists(select 1 from manufacturing.finishing f where f.requirement_id = p_requirement_id
          or f.production_key = target.production_key) then
        raise sqlstate 'PT409' using message = 'A finishing job already exists';
      end if;
      insert into manufacturing.finishing(production_key, requirement_id, color, required_quantity, active)
      select production_key, requirement_id, color, required_quantity, active
      from jsonb_populate_record(null::manufacturing.finishing, new_row)
      returning id into inserted_id;
      select to_jsonb(f) into after_row from manufacturing.finishing f where f.id = inserted_id;
      insert into manufacturing.write_history(request_id, entity, row_id, before_row, after_row)
        values(p_request_id, 'finishing', inserted_id, '{}'::jsonb, after_row);
      finishing_touched := true;
    else
      raise exception 'Invalid engineering override insert';
    end if;
  end loop;

  -- Every remaining adjustment matches its column; every revert restored the retained sync value.
  for existing in select * from manufacturing.engineering_overrides o
    where (o.entity = 'requirements' and o.row_id = p_requirement_id) or (o.entity = 'parts' and o.row_id = target.part_id)
  loop
    execute format('select to_jsonb(t)->%L from manufacturing.%I t where id=$1', existing.field, existing.entity)
      into current_value using existing.row_id;
    if current_value is distinct from existing.value then raise exception 'Engineering override does not match its column'; end if;
  end loop;
  for v_field, current_value in select key, value from jsonb_each(cleared) loop
    execute format('select to_jsonb(t)->%L from manufacturing.%I t where id=$1', split_part(v_field, '|', 3), split_part(v_field, '|', 1))
      into after_row using split_part(v_field, '|', 2)::bigint;
    if after_row is distinct from current_value then raise exception 'Reverted field does not match Onshape'; end if;
  end loop;

  select * into target from manufacturing.requirements where id = p_requirement_id;
  if target.off_the_shelf then
    if exists(select 1 from manufacturing.operations o where o.requirement_id = p_requirement_id and o.active_in_routing)
      or exists(select 1 from manufacturing.finishing f where f.requirement_id = p_requirement_id and f.active) then
      raise exception 'Off-the-shelf parts cannot keep active routing or finishing';
    end if;
    return p_result;
  end if;
  if off_the_shelf_changed then
    -- Switching back to manufactured restores the full routing and finishing.
    routing_fields := array['machine_op1','machine_op2','machine_op3','machine_op4'];
    finishing_touched := true;
  end if;
  if finishing_touched and (
    (target.finishing in ('Red','Black') and not exists(select 1 from manufacturing.finishing f
      where f.requirement_id = p_requirement_id and f.active and f.color = target.finishing
        and f.required_quantity = target.required_quantity))
    or (coalesce(target.finishing, 'None') not in ('Red','Black') and exists(select 1 from manufacturing.finishing f
      where f.requirement_id = p_requirement_id and f.active))) then
    raise exception 'Finishing job does not match the corrected requirement';
  end if;
  -- Only corrected stages are checked, so unrelated legacy rows cannot block a fix.
  for stage in 1..4 loop
      continue when not ('machine_op' || stage = any(routing_fields));
      desired := case stage when 1 then target.machine_op1 when 2 then target.machine_op2
        when 3 then target.machine_op3 else target.machine_op4 end;
      if exists(select 1 from manufacturing.operations o where o.requirement_id = p_requirement_id
          and o.active_in_routing and o.work_type = 'Manufacturing' and o.operation_number = 'OP' || stage
          and o.machine is distinct from desired)
        or (desired is not null and not exists(select 1 from manufacturing.operations o
          where o.requirement_id = p_requirement_id and o.active_in_routing and o.work_type = 'Manufacturing'
            and o.operation_number = 'OP' || stage)) then
        raise exception 'Operations do not match the corrected routing';
      end if;
  end loop;
  return p_result;
end;
$$;
revoke all on function public.manufacturing_apply_engineering_overrides(uuid,uuid,text,text,bigint,jsonb,jsonb,jsonb,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.manufacturing_apply_engineering_overrides(uuid,uuid,text,text,bigint,jsonb,jsonb,jsonb,text,jsonb)
  to service_role;

-- p_file null reverts to the synced file. The server verifies and uploads the
-- content-addressed object before calling this.
create function public.manufacturing_set_attachment_override(
  p_request_id uuid, p_actor uuid, p_override_token text, p_requirement_id bigint,
  p_kind text, p_file jsonb, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prior manufacturing.write_requests; fingerprint text; actor_name text; v_part_id bigint;
  removed manufacturing.attachment_overrides; v_sha text; v_path text; result jsonb;
begin
  set local lock_timeout = '5s';
  perform pg_catalog.pg_advisory_xact_lock(190, 20260905);
  lock table manufacturing.write_control, manufacturing.write_requests, manufacturing.requirements,
    manufacturing.attachment_overrides in share row exclusive mode;
  if not exists(select 1 from manufacturing.write_control where enabled) then
    raise exception 'Supabase manufacturing writes are disabled' using errcode = '42501';
  end if;
  select display_name into actor_name from public.profiles where id = p_actor and approved and role = 'admin' for share;
  if not found then raise exception 'Approved administrator required' using errcode = '42501'; end if;
  if p_request_id is null or p_kind is null or p_kind not in ('drawing-pdf','step') or length(coalesce(p_reason, '')) > 1000
    or (p_file is not null and p_file <> 'null'::jsonb and jsonb_typeof(p_file) <> 'object') then
    raise exception 'Invalid attachment override request';
  end if;
  fingerprint := md5(jsonb_build_array(p_actor,p_override_token,p_requirement_id,p_kind,p_file,p_reason)::text);
  select * into prior from manufacturing.write_requests where request_id = p_request_id;
  if found then
    if prior.payload_hash <> fingerprint then raise sqlstate 'PT409' using message = 'Request ID reused with different payload'; end if;
    return prior.result;
  end if;
  if p_override_token is distinct from md5(manufacturing.engineering_override_state(p_requirement_id)::text) then
    raise sqlstate 'PT409' using message = 'Manufacturing state changed';
  end if;
  select part_id into v_part_id from manufacturing.requirements where id = p_requirement_id;
  if v_part_id is null then raise sqlstate 'PT409' using message = 'This requirement is not linked to a part'; end if;

  if p_file is null or p_file = 'null'::jsonb then
    delete from manufacturing.attachment_overrides where part_id = v_part_id and kind = p_kind returning * into removed;
    if removed.id is null then raise sqlstate 'PT409' using message = 'This file has not been replaced'; end if;
    result := jsonb_build_object('requirementId', p_requirement_id, 'kind', p_kind, 'file', null);
  else
    v_sha := p_file->>'sha256';
    if coalesce(v_sha, '') !~ '^[0-9a-f]{64}$' or coalesce(btrim(p_file->>'original_name'), '') = ''
      or jsonb_typeof(p_file->'byte_size') is distinct from 'number' or (p_file->>'byte_size')::bigint <= 0 then
      raise exception 'Invalid attachment override file';
    end if;
    v_path := 'sha256/' || left(v_sha, 2) || '/' || v_sha || case p_kind when 'drawing-pdf' then '.pdf' else '.step' end;
    if not exists(select 1 from storage.buckets b join storage.objects o on o.bucket_id = b.id
        where b.id = 'manufacturing-files' and not b.public and o.name = v_path) then
      raise exception 'Verified replacement file is missing or the bucket is public';
    end if;
    if exists(select 1 from (select distinct on (kind) sha256 from manufacturing.attachments
        where part_id = v_part_id and kind = p_kind order by kind, position, id) a where a.sha256 = v_sha) then
      raise sqlstate 'PT409' using message = 'That file matches the Onshape export; revert the replacement instead';
    end if;
    insert into manufacturing.attachment_overrides(part_id, kind, original_name, content_type, byte_size, sha256,
      storage_bucket, storage_path, reason, updated_by, updated_by_name)
    values(v_part_id, p_kind, btrim(p_file->>'original_name'),
      case p_kind when 'drawing-pdf' then 'application/pdf' else 'application/step' end,
      (p_file->>'byte_size')::bigint, v_sha, 'manufacturing-files', v_path, coalesce(p_reason, ''),
      p_actor, coalesce(actor_name, p_actor::text))
    on conflict (part_id, kind) do update set original_name = excluded.original_name,
      byte_size = excluded.byte_size, sha256 = excluded.sha256, storage_path = excluded.storage_path,
      reason = excluded.reason, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name,
      updated_at = clock_timestamp();
    result := jsonb_build_object('requirementId', p_requirement_id, 'kind', p_kind,
      'file', jsonb_build_object('name', btrim(p_file->>'original_name'), 'sha256', v_sha, 'byte_size', (p_file->>'byte_size')::bigint));
  end if;
  insert into manufacturing.write_requests(request_id, actor, action, payload_hash, result)
    values(p_request_id, p_actor, 'attachment_override', fingerprint, result);
  insert into manufacturing.engineering_override_events(request_id,entity,row_id,field,action,value,reason,actor,actor_name)
    values(p_request_id, 'parts', v_part_id, p_kind, case when result->'file' = 'null'::jsonb then 'cleared' else 'set' end,
      case when result->'file' = 'null'::jsonb
        then jsonb_build_object('name', removed.original_name, 'sha256', removed.sha256, 'byte_size', removed.byte_size)
        else result->'file' end,
      coalesce(p_reason, ''), p_actor, coalesce(actor_name, p_actor::text));
  return result;
end;
$$;
revoke all on function public.manufacturing_set_attachment_override(uuid,uuid,text,bigint,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.manufacturing_set_attachment_override(uuid,uuid,text,bigint,text,jsonb,text) to service_role;

-- Resolvers prefer an administrator replacement over the synced file.
create or replace function public.manufacturing_file_for_requirement(p_requirement_id bigint, p_kind text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('bucket', f.storage_bucket, 'path', f.storage_path, 'name', f.original_name,
        'content_type', f.content_type, 'byte_size', f.byte_size, 'sha256', f.sha256)
      from manufacturing.requirements r
      join manufacturing.attachment_overrides f on f.part_id = r.part_id
      where r.id = p_requirement_id and f.kind = p_kind),
    (select jsonb_build_object('bucket', a.storage_bucket, 'path', a.storage_path, 'name', a.original_name,
        'content_type', a.content_type, 'byte_size', a.byte_size, 'sha256', a.sha256)
      from manufacturing.requirements r
      join manufacturing.attachments a on a.part_id = r.part_id
      where r.id = p_requirement_id and a.kind = p_kind
      order by a.position, a.id
      limit 1));
$$;

create or replace function public.manufacturing_attachment_manifest()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(entry order by part_id, kind, position), '[]'::jsonb) from (
    select a.part_id, a.kind, a.position, jsonb_build_object(
      'part_id', a.part_id, 'kind', a.kind, 'position', a.position, 'source_field_id', a.source_field_id,
      'source_url', a.source_url, 'original_name', a.original_name, 'content_type', a.content_type,
      'byte_size', a.byte_size, 'sha256', a.sha256, 'storage_bucket', a.storage_bucket,
      'storage_path', a.storage_path, 'override', false) entry
    from manufacturing.attachments a
    where not exists(select 1 from manufacturing.attachment_overrides f where f.part_id = a.part_id and f.kind = a.kind)
    union all
    select f.part_id, f.kind, 0, jsonb_build_object(
      'part_id', f.part_id, 'kind', f.kind, 'position', 0, 'source_field_id', null, 'source_url', null,
      'original_name', f.original_name, 'content_type', f.content_type, 'byte_size', f.byte_size,
      'sha256', f.sha256, 'storage_bucket', f.storage_bucket, 'storage_path', f.storage_path, 'override', true)
    from manufacturing.attachment_overrides f
  ) files;
$$;

-- Extends the assembly-preview resolver (20260910031802). A replacement STEP
-- uses only its own preview; synced and assembly-derived previews show the
-- Onshape geometry the admin replaced.
create or replace function public.manufacturing_preview_for_requirement(p_requirement_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with requirement as (
    select r.id, r.part_id, exists(select 1 from manufacturing.attachment_overrides f
      where f.part_id = r.part_id and f.kind = 'step') as replaced
    from manufacturing.requirements r where r.id = p_requirement_id
  ), selected_step as (
    select a.* from requirement q
    join manufacturing.attachments a on a.part_id = q.part_id
    where a.kind = 'step' and not q.replaced
    order by a.position, a.id limit 1
  ), candidates as (
    select 0 as priority, v.storage_bucket, v.storage_path, v.content_type,
      v.byte_size, v.sha256, v.source_sha256
    from requirement q
    join manufacturing.attachment_overrides f on f.part_id = q.part_id and f.kind = 'step'
    join manufacturing.override_part_previews v on v.override_id = f.id and v.source_sha256 = f.sha256
    union all
    select 1, p.storage_bucket, p.storage_path, p.content_type,
      p.byte_size, p.sha256, p.source_sha256
    from selected_step a join manufacturing.part_previews p
      on p.source_attachment_id = a.id and p.source_sha256 = a.sha256
    union all
    select 2, p.storage_bucket, p.storage_path, 'model/gltf-binary',
      p.byte_size, p.sha256, p.source_sha256
    from requirement q
    join manufacturing.assembly_part_previews p on p.part_id = q.part_id
    where not q.replaced
      and not exists(select 1 from manufacturing.part_previews existing where existing.part_id = q.part_id)
  )
  select jsonb_build_object('bucket', storage_bucket, 'path', storage_path,
    'content_type', content_type, 'byte_size', byte_size, 'sha256', sha256, 'source_sha256', source_sha256)
  from candidates order by priority limit 1;
$$;

create function public.manufacturing_override_step_preview_sources()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'override_id', f.id, 'part_id', f.part_id, 'original_name', f.original_name, 'byte_size', f.byte_size,
    'sha256', f.sha256, 'storage_bucket', f.storage_bucket, 'storage_path', f.storage_path,
    'preview_source_sha256', v.source_sha256, 'preview_generator', v.generator,
    'preview_generator_version', v.generator_version, 'preview_byte_size', v.byte_size,
    'preview_sha256', v.sha256, 'preview_storage_bucket', v.storage_bucket, 'preview_storage_path', v.storage_path
  ) order by f.part_id), '[]'::jsonb)
  from manufacturing.attachment_overrides f
  left join manufacturing.override_part_previews v on v.override_id = f.id
  where f.kind = 'step';
$$;
revoke all on function public.manufacturing_override_step_preview_sources() from public, anon, authenticated;
grant execute on function public.manufacturing_override_step_preview_sources() to service_role;

create function public.manufacturing_register_override_preview(
  p_override_id bigint, p_source_sha256 text, p_generator text, p_generator_version text, p_content_type text,
  p_byte_size bigint, p_sha256 text, p_storage_bucket text, p_storage_path text, p_verified_at timestamptz
) returns bigint language plpgsql security definer set search_path = '' as $$
declare source manufacturing.attachment_overrides; preview_id bigint;
begin
  select * into source from manufacturing.attachment_overrides where id = p_override_id for share;
  if not found or source.kind <> 'step' then
    raise exception 'Replacement STEP is missing' using errcode = '23503';
  end if;
  -- A replacement uploaded during generation keeps its row but changes its hash.
  if source.sha256 is distinct from p_source_sha256 then
    raise sqlstate 'PT409' using message = 'The replacement STEP changed while its preview was generated';
  end if;
  if coalesce(p_generator, '') = '' or coalesce(p_generator_version, '') = '' or p_content_type <> 'model/gltf-binary'
    or p_byte_size <= 0 or p_sha256 !~ '^[0-9a-f]{64}$' or p_storage_bucket <> 'manufacturing-files'
    or p_storage_path <> 'sha256/' || left(p_sha256, 2) || '/' || p_sha256 || '.glb' or p_verified_at is null then
    raise exception 'Invalid replacement STEP preview';
  end if;
  insert into manufacturing.override_part_previews(override_id, source_sha256, generator, generator_version,
    content_type, byte_size, sha256, storage_bucket, storage_path, verified_at)
  values(p_override_id, p_source_sha256, p_generator, p_generator_version, p_content_type, p_byte_size,
    p_sha256, p_storage_bucket, p_storage_path, p_verified_at)
  on conflict (override_id) do update set source_sha256 = excluded.source_sha256, generator = excluded.generator,
    generator_version = excluded.generator_version, byte_size = excluded.byte_size, sha256 = excluded.sha256,
    storage_path = excluded.storage_path, verified_at = excluded.verified_at, updated_at = clock_timestamp()
  returning id into preview_id;
  return preview_id;
end;
$$;
revoke all on function public.manufacturing_register_override_preview(bigint,text,text,text,text,bigint,text,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.manufacturing_register_override_preview(bigint,text,text,text,text,bigint,text,text,text,timestamptz)
  to service_role;

-- Every active correction, so the CAD team can fix Onshape and let them retire.
create function public.manufacturing_engineering_correction_list()
returns jsonb language sql stable security definer set search_path = '' as $$
  with corrections as (
    select 'field' kind, o.field, o.value, o.synced_value, coalesce(r.part_id, o.row_id) part_id,
      r.id requirement_id, o.reason, o.updated_by_name, o.updated_at
    from manufacturing.engineering_overrides o
    left join manufacturing.requirements r on o.entity = 'requirements' and r.id = o.row_id
    union all
    select 'file', f.kind, jsonb_build_object('name', f.original_name, 'sha256', f.sha256),
      (select jsonb_build_object('name', a.original_name, 'sha256', a.sha256) from manufacturing.attachments a
        where a.part_id = f.part_id and a.kind = f.kind order by a.position, a.id limit 1),
      f.part_id, null, f.reason, f.updated_by_name, f.updated_at
    from manufacturing.attachment_overrides f
    union all
    select 'off_the_shelf', 'off_the_shelf', 'true'::jsonb, 'false'::jsonb, r.part_id, r.id, '',
      r.off_the_shelf_changed_by, r.off_the_shelf_changed_at
    from manufacturing.requirements r where r.off_the_shelf
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', c.kind, 'field', c.field, 'value', c.value, 'synced_value', c.synced_value,
    'part_id', c.part_id, 'part_number', p.part_number, 'part_name', p.name,
    'requirement_id', c.requirement_id, 'assembly_number', a.assembly_number,
    'source_document', r.source_document, 'active_in_bom', r.active_in_bom,
    'reason', c.reason, 'updated_by_name', c.updated_by_name, 'updated_at', c.updated_at
  ) order by p.part_number, c.requirement_id nulls first, c.field), '[]'::jsonb)
  from corrections c
  left join manufacturing.parts p on p.id = c.part_id
  left join manufacturing.requirements r on r.id = c.requirement_id
  left join manufacturing.assemblies a on a.id = r.assembly_id;
$$;
revoke all on function public.manufacturing_engineering_correction_list() from public, anon, authenticated;
grant execute on function public.manufacturing_engineering_correction_list() to service_role;

commit;
