-- Quantity corrections on parts that already passed QC. The admin chooses:
-- * approved: the corrected quantity was made and approved, so pre-QC completed
--   counts (and their ledgers) are rewritten to the corrected quantity; or
-- * made: the original quantity was made. Completed counts are kept; a larger
--   quantity reopens work for the extra parts and resets the QC outcome.
-- Replaces two functions from 20260922190000_admin_engineering_overrides.sql:
-- the override state now carries the QC outcome and part location, and the
-- apply RPC accepts the completed-count rewrite, validated like shop writes.

create or replace function manufacturing.engineering_override_state(p_requirement_id bigint) returns jsonb
language sql stable set search_path = '' as $$
  with r as (select * from manufacturing.requirements where id = p_requirement_id),
  p as (select part.* from manufacturing.parts part join r on part.id = r.part_id)
  select jsonb_build_object(
    'requirement', (select jsonb_build_object('id', id, 'production_key', production_key, 'part_id', part_id,
      'required_quantity', required_quantity, 'finishing', finishing, 'machine_op1', machine_op1,
      'machine_op2', machine_op2, 'machine_op3', machine_op3, 'machine_op4', machine_op4,
      'active_in_bom', active_in_bom, 'obsolete', obsolete, 'off_the_shelf', off_the_shelf,
      'off_the_shelf_changed_by', off_the_shelf_changed_by, 'off_the_shelf_changed_at', off_the_shelf_changed_at,
      'qc_outcome', qc_outcome, 'part_location', part_location) from r),
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

create or replace function public.manufacturing_apply_engineering_overrides(
  p_request_id uuid, p_actor uuid, p_expected text, p_override_token text, p_requirement_id bigint,
  p_overrides jsonb, p_changes jsonb, p_inserts jsonb, p_reason text, p_result jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prior manufacturing.write_requests; fingerprint text; actor_name text; target manufacturing.requirements;
  item jsonb; v_entity text; v_row_id bigint; v_field text; patch jsonb; allowed text[]; assignments text;
  before_row jsonb; after_row jsonb; current_value jsonb; existing manufacturing.engineering_overrides;
  had_override boolean; cleared jsonb := '{}'::jsonb; new_row jsonb; inserted_id bigint; has_work boolean;
  routing_fields text[] := '{}'; finishing_touched boolean := false; stage integer; desired text;
  off_the_shelf_changed boolean := false; quantity_overridden boolean := false; rewritten bigint[] := '{}';
  ledger jsonb; allocation jsonb; claimed numeric; completed numeric; ordinal integer;
begin
  set local lock_timeout = '5s';
  -- Serialize with the engineering sync, then take the shop-write locks in their usual order.
  perform pg_catalog.pg_advisory_xact_lock(190, 20260905);
  lock table manufacturing.write_control, manufacturing.write_requests, manufacturing.requirements,
    manufacturing.operations, manufacturing.operation_allocations, manufacturing.finishing, manufacturing.parts,
    manufacturing.engineering_overrides,
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
    quantity_overridden := quantity_overridden or v_field = 'required_quantity';
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
      when 'operations' then array['machine','active_in_routing','status','completed_at','completed_quantity','quantity_ledger','machinist']
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
      -- Completed counts change only when a quantity correction on a passed part
      -- records that QC approved the corrected quantity (checked after the loop).
      if patch ?| array['completed_quantity','quantity_ledger','machinist'] then
        if not (patch ? 'completed_quantity' and patch ? 'quantity_ledger') or not quantity_overridden
          or target.qc_outcome is distinct from 'Passed'
          or before_row->>'work_type' is distinct from 'Manufacturing'
          or lower(btrim(coalesce(before_row->>'machine', ''))) = 'threaded insert'
          or coalesce((before_row->>'active_in_routing')::boolean, false) is false
          or coalesce((before_row->>'claimed_quantity')::numeric, 0) <> 0 then
          raise exception 'Completed quantities can only follow a passed-QC quantity correction';
        end if;
        rewritten := rewritten || v_row_id;
      end if;
    end if;
    select string_agg(format('%1$I = (jsonb_populate_record(null::manufacturing.%2$I, $1)).%1$I', k, v_entity), ', ' order by k)
      into assignments from jsonb_object_keys(patch) k;
    execute format('update manufacturing.%1$I set %2$s, updated_at=clock_timestamp() where id=$2 returning to_jsonb(%1$I.*)',
      v_entity, assignments) into after_row using patch, v_row_id;
    if v_entity = 'operations' and patch ? 'quantity_ledger' then
      -- Same ledger rules as manufacturing_commit, keeping operation_allocations in step.
      ledger := (after_row->>'quantity_ledger')::jsonb;
      if jsonb_typeof(ledger) is distinct from 'array' then raise exception 'Invalid quantity ledger'; end if;
      claimed := 0; completed := 0; ordinal := 0;
      delete from manufacturing.operation_allocations where operation_id = v_row_id;
      for allocation in select value from jsonb_array_elements(ledger) loop
        if coalesce(allocation->>'userId','') = '' or coalesce(allocation->>'name','') = ''
          or jsonb_typeof(allocation->'claimed') is distinct from 'number'
          or jsonb_typeof(allocation->'completed') is distinct from 'number'
          or (allocation->>'claimed')::numeric < 0 or (allocation->>'completed')::numeric < 0
          or trunc((allocation->>'claimed')::numeric) <> (allocation->>'claimed')::numeric
          or trunc((allocation->>'completed')::numeric) <> (allocation->>'completed')::numeric then
          raise exception 'Invalid allocation';
        end if;
        claimed := claimed + (allocation->>'claimed')::numeric; completed := completed + (allocation->>'completed')::numeric;
        insert into manufacturing.operation_allocations values(v_row_id, ordinal, allocation->>'userId', allocation->>'name',
          (allocation->>'claimed')::numeric, (allocation->>'completed')::numeric, allocation);
        ordinal := ordinal + 1;
      end loop;
      if claimed is distinct from coalesce((after_row->>'claimed_quantity')::numeric, 0)
        or completed is distinct from (after_row->>'completed_quantity')::numeric then
        raise exception 'Allocation totals do not match operation quantities';
      end if;
    end if;
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
  if cardinality(rewritten) > 0 and (target.qc_outcome is distinct from 'Passed'
    or exists(select 1 from manufacturing.operations o where o.id = any(rewritten)
      and (o.status is distinct from 'Complete' or o.completed_quantity is distinct from target.required_quantity))) then
    raise exception 'Approved quantities must match the corrected quantity';
  end if;
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
