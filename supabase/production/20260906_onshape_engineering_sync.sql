-- Engineering sync API for 190-Manufacturing experimental b915b1439ae4fed616f24935de552734ebea525b.
-- Apply manually AFTER normalized_manufacturing and manufacturing_attachments.
-- This repository does not apply this migration or change PostgREST exposure.
begin;

alter table manufacturing.assemblies
  add column latest_released_revision text,
  add column master_baseline_revision text,
  add column integration_status text,
  add column discovery_master text,
  add column onshape_url text,
  add column last_synced_at timestamptz,
  add column cad_synced boolean not null default false;
-- Imported field identifiers remain intact. New Onshape attachments have no legacy field ID.
alter table manufacturing.attachments alter column source_field_id drop not null;
-- Retain the contract's nonunique operations_key_idx and existing shop records.

create table manufacturing.engineering_sync_runs (
  id uuid primary key,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','success','partial','failed')),
  github_run_url text not null,
  summary jsonb not null default '{}'
);
alter table manufacturing.engineering_sync_runs enable row level security;
revoke all on manufacturing.engineering_sync_runs from public, anon, authenticated, service_role;

create function public.manufacturing_begin_engineering_sync(p_run_id uuid, p_run_url text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  insert into manufacturing.engineering_sync_runs(id, github_run_url)
  values(p_run_id, coalesce(p_run_url, '')) on conflict(id) do nothing;
  return p_run_id;
end;
$$;

create function public.manufacturing_finish_engineering_sync(p_run_id uuid, p_status text, p_summary jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status is null or p_status not in ('success','partial','failed') or p_summary is null then
    raise exception 'Invalid engineering sync result';
  end if;
  -- An uncertain HTTP response must never turn a committed success into a failure.
  update manufacturing.engineering_sync_runs
  set status=p_status, summary=p_summary, finished_at=clock_timestamp()
  where id=p_run_id and status='running';
end;
$$;

create function public.manufacturing_engineering_sync_state()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'Assembly Number', assembly_number, 'Latest Released Revision', latest_released_revision,
    'Sync Schema Version', sync_schema_version, 'Discovery Master', discovery_master,
    'Integration Status', integration_status, 'CAD Synced', cad_synced
  )), '[]'::jsonb) from manufacturing.assemblies;
$$;

create function public.manufacturing_engineering_file_state(p_part_numbers text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from (
    select p.part_number, a.kind,
      case a.kind when 'drawing-pdf' then p.drawing_export_key else p.step_export_key end as export_key,
      count(*) as file_count
    from manufacturing.parts p join manufacturing.attachments a on a.part_id=p.id
    where p.part_number=any(p_part_numbers) group by p.id, a.kind
  ) s;
$$;

create function public.manufacturing_apply_engineering_sync(p_run_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  run manufacturing.engineering_sync_runs;
  entity text; row_key text; allowed text[]; v jsonb; f jsonb; g jsonb;
  roots text[]; part_id_value bigint; requirement_id_value bigint; assembly_id_value bigint;
  position_value integer; result_summary jsonb; error_message text;
  requirements_deactivated integer; operations_deactivated integer; finishing_deactivated integer;
  operation_matches integer; duplicate_operations_preserved integer := 0;
begin
  -- Serialize engineering commits, while shop transactions retain their ordinary locks.
  perform pg_catalog.pg_advisory_xact_lock(190, 20260905);
  select * into strict run from manufacturing.engineering_sync_runs where id=p_run_id for update;
  if run.status <> 'running' then return run.summary; end if;
  -- A subtransaction rolls back EVERY BOM/catalog change on error, retaining the audit result.
  begin
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
      raise exception 'Invalid engineering payload';
    end if;
    foreach entity in array array['attachments','warnings','discovered_roots'] loop
      if jsonb_typeof(p_payload->entity) is distinct from 'array' then
        raise exception 'Missing engineering array: %', entity;
      end if;
    end loop;
    if exists(select 1 from manufacturing.engineering_sync_runs
      where id<>p_run_id and summary->>'committed'='true' and finished_at>run.started_at) then
      raise exception 'Another engineering run committed after this run started; retry from fresh state';
    end if;
    if jsonb_typeof(p_payload->'synced_roots') is distinct from 'array' then
      raise exception 'Successful root scope is required';
    end if;
    select coalesce(array_agg(value),array[]::text[]) into roots from jsonb_array_elements_text(p_payload->'synced_roots');
    if cardinality(roots)=0 and (
      coalesce(p_payload->>'discovery_master','')='' or exists(
        select 1 from unnest(array['assemblies','parts','requirements','operations','finishing','attachments']) e
        where jsonb_array_length(p_payload->e)>0)) then
      raise exception 'Empty scope is only allowed for discovery membership bookkeeping';
    end if;
    if exists(select 1 from unnest(roots) r where r is null or btrim(r)='') then
      raise exception 'Empty root scope';
    end if;
    -- Explicit allowlists reject shop fields and unknown columns, even for service_role.
    foreach entity in array array['assemblies','parts','requirements','operations','finishing'] loop
      case entity
        when 'assemblies' then allowed:=array['assembly_number','subsystem_name','active','sync_schema_version','latest_released_revision','master_baseline_revision','integration_status','discovery_master','onshape_url','last_synced_at']; row_key:='assembly_number';
        when 'parts' then allowed:=array['part_number','name','description','material','manufacturing_method','vendor','revision','onshape_url','category','drawing_url','active']; row_key:='part_number';
        when 'requirements' then allowed:=array['production_key','part_number','assembly_number','configuration','required_quantity','bom_positions','onshape_url','source_document','source_root','source_assembly_revision','required_part_revision','machine_op1','machine_op2','machine_op3','machine_op4','finishing','active_in_bom']; row_key:='production_key';
        when 'operations' then allowed:=array['operation_key','production_key','operation_number','machine','active_in_routing','work_type']; row_key:='operation_key';
        when 'finishing' then allowed:=array['production_key','color','required_quantity','active']; row_key:='production_key';
      end case;
      if jsonb_typeof(p_payload->entity) is distinct from 'array' then
        raise exception 'Missing engineering array: %', entity;
      end if;
      for v in select value from jsonb_array_elements(p_payload->entity) loop
        if jsonb_typeof(v)<>'object' or coalesce(btrim(v->>row_key),'')='' then
          raise exception 'Missing business key for %', entity;
        end if;
        if exists(select 1 from jsonb_object_keys(v) k where not(k=any(allowed))) then
          raise exception 'Unknown or shop-owned field in %', entity;
        end if;
      end loop;
      if exists(select 1 from jsonb_array_elements(p_payload->entity) r
        group by r->>row_key having count(*)>1) then
        raise exception 'Duplicate business key in %', entity;
      end if;
    end loop;
    if exists(select 1 from unnest(roots) root where not exists(
      select 1 from jsonb_array_elements(p_payload->'assemblies') a
      where a->>'assembly_number'=root and coalesce(a->>'latest_released_revision','')<>'')) then
      raise exception 'Every successful root must have a released assembly record';
    end if;

    for v in select value from jsonb_array_elements(p_payload->'assemblies') loop
      v:=v || jsonb_build_object('last_synced_at',clock_timestamp());
      if v->>'assembly_number'=any(roots) then v:=v || jsonb_build_object('cad_synced',coalesce((p_payload->>'cad_synced')::boolean,false)); end if;
      if not(v ? 'cad_synced') then v:=v || jsonb_build_object('cad_synced',false); end if;
      insert into manufacturing.assemblies as existing(assembly_number, subsystem_name, active, sync_schema_version, latest_released_revision, master_baseline_revision, integration_status, discovery_master, onshape_url, last_synced_at, cad_synced)
      select assembly_number, subsystem_name, active, sync_schema_version, latest_released_revision, master_baseline_revision, integration_status, discovery_master, onshape_url, last_synced_at, cad_synced from jsonb_populate_record(null::manufacturing.assemblies,v)
      on conflict (assembly_number) where assembly_number is not null and assembly_number<>'' do update set
        subsystem_name=case when v ? 'subsystem_name' then excluded.subsystem_name else existing.subsystem_name end,
        active=case when v ? 'active' then excluded.active else existing.active end,
        sync_schema_version=case when v ? 'sync_schema_version' then excluded.sync_schema_version else existing.sync_schema_version end,
        latest_released_revision=case when v ? 'latest_released_revision' then excluded.latest_released_revision else existing.latest_released_revision end,
        master_baseline_revision=case when v ? 'master_baseline_revision' then excluded.master_baseline_revision else existing.master_baseline_revision end,
        integration_status=case when v ? 'integration_status' then excluded.integration_status else existing.integration_status end,
        discovery_master=case when v ? 'discovery_master' then excluded.discovery_master else existing.discovery_master end,
        onshape_url=case when v ? 'onshape_url' then excluded.onshape_url else existing.onshape_url end,
        last_synced_at=case when v ? 'last_synced_at' then excluded.last_synced_at else existing.last_synced_at end,
        cad_synced=case when v->>'assembly_number'=any(roots) then excluded.cad_synced else existing.cad_synced end,
        updated_at=clock_timestamp();
    end loop;

    for v in select value from jsonb_array_elements(p_payload->'parts') loop
      v:=v || jsonb_build_object('last_synced_at',clock_timestamp());
      insert into manufacturing.parts as existing(part_number, name, description, material, manufacturing_method, vendor, revision, onshape_url, category, drawing_url, active, last_synced_at)
      select part_number, name, description, material, manufacturing_method, vendor, revision, onshape_url, category, drawing_url, active, last_synced_at from jsonb_populate_record(null::manufacturing.parts,v)
      on conflict (part_number) where part_number is not null and part_number<>'' do update set
        name=case when v ? 'name' then excluded.name else existing.name end,
        description=case when v ? 'description' then excluded.description else existing.description end,
        material=case when v ? 'material' then excluded.material else existing.material end,
        manufacturing_method=case when v ? 'manufacturing_method' then excluded.manufacturing_method else existing.manufacturing_method end,
        vendor=case when v ? 'vendor' then excluded.vendor else existing.vendor end,
        revision=case when v ? 'revision' then excluded.revision else existing.revision end,
        onshape_url=case when v ? 'onshape_url' then excluded.onshape_url else existing.onshape_url end,
        category=case when v ? 'category' then excluded.category else existing.category end,
        drawing_url=case when v ? 'drawing_url' then excluded.drawing_url else existing.drawing_url end,
        active=case when v ? 'active' then excluded.active else existing.active end,
        last_synced_at=case when v ? 'last_synced_at' then excluded.last_synced_at else existing.last_synced_at end,
        updated_at=clock_timestamp();
    end loop;

    for v in select value from jsonb_array_elements(p_payload->'requirements') loop
      if not(coalesce(v->>'source_root','')=any(roots)) then
        raise exception 'Requirement outside successful root scope';
      end if;
      if not exists(select 1 from jsonb_array_elements(p_payload->'assemblies') a
        where a->>'assembly_number'=v->>'source_root'
          and a->>'latest_released_revision'=v->>'source_assembly_revision') then
        raise exception 'Requirement revision differs from successful root';
      end if;
      if not exists(select 1 from jsonb_array_elements(p_payload->'parts') p
        where p->>'part_number'=v->>'part_number') then
        raise exception 'Requirement part is absent from payload';
      end if;
      select id into strict part_id_value from manufacturing.parts where part_number=v->>'part_number';
      assembly_id_value:=null;
      if coalesce(v->>'assembly_number','')<>'' then
        select id into strict assembly_id_value from manufacturing.assemblies where assembly_number=v->>'assembly_number';
      end if;
      if exists(select 1 from manufacturing.requirements r where r.production_key=v->>'production_key'
        and coalesce(r.source_root,'')<>'' and r.source_root<>v->>'source_root') then
        raise exception 'Cannot move an existing requirement between roots';
      end if;
      if (v->>'required_quantity')::numeric is null or (v->>'required_quantity')::numeric < 0
        or (v->>'required_quantity')::numeric::text in ('NaN','Infinity','-Infinity') then
        raise exception 'Invalid required engineering quantity';
      end if;
      v:=(v-'part_number'-'assembly_number') || jsonb_build_object('part_id',part_id_value,
        'assembly_id',assembly_id_value, 'engineering_changed',false);
      v:=v || jsonb_build_object('last_synced_at',clock_timestamp());
      insert into manufacturing.requirements as existing(production_key, configuration, required_quantity, bom_positions, onshape_url, source_document, source_root, source_assembly_revision, required_part_revision, machine_op1, machine_op2, machine_op3, machine_op4, finishing, active_in_bom, part_id, assembly_id, engineering_changed, last_synced_at)
      select production_key, configuration, required_quantity, bom_positions, onshape_url, source_document, source_root, source_assembly_revision, required_part_revision, machine_op1, machine_op2, machine_op3, machine_op4, finishing, active_in_bom, part_id, assembly_id, engineering_changed, last_synced_at from jsonb_populate_record(null::manufacturing.requirements,v)
      on conflict (production_key) where production_key is not null and production_key<>'' do update set
        configuration=case when v ? 'configuration' then excluded.configuration else existing.configuration end,
        required_quantity=case when v ? 'required_quantity' then excluded.required_quantity else existing.required_quantity end,
        bom_positions=case when v ? 'bom_positions' then excluded.bom_positions else existing.bom_positions end,
        onshape_url=case when v ? 'onshape_url' then excluded.onshape_url else existing.onshape_url end,
        source_document=case when v ? 'source_document' then excluded.source_document else existing.source_document end,
        source_root=case when v ? 'source_root' then excluded.source_root else existing.source_root end,
        source_assembly_revision=case when v ? 'source_assembly_revision' then excluded.source_assembly_revision else existing.source_assembly_revision end,
        required_part_revision=case when v ? 'required_part_revision' then excluded.required_part_revision else existing.required_part_revision end,
        machine_op1=case when v ? 'machine_op1' then excluded.machine_op1 else existing.machine_op1 end,
        machine_op2=case when v ? 'machine_op2' then excluded.machine_op2 else existing.machine_op2 end,
        machine_op3=case when v ? 'machine_op3' then excluded.machine_op3 else existing.machine_op3 end,
        machine_op4=case when v ? 'machine_op4' then excluded.machine_op4 else existing.machine_op4 end,
        finishing=case when v ? 'finishing' then excluded.finishing else existing.finishing end,
        active_in_bom=case when v ? 'active_in_bom' then excluded.active_in_bom else existing.active_in_bom end,
        part_id=case when v ? 'part_id' then excluded.part_id else existing.part_id end,
        assembly_id=case when v ? 'assembly_id' then excluded.assembly_id else existing.assembly_id end,
        engineering_changed=coalesce(existing.engineering_changed,false) or
          row(existing.configuration,existing.required_quantity,existing.bom_positions,existing.onshape_url,existing.source_document,existing.source_root,existing.source_assembly_revision,existing.required_part_revision,existing.machine_op1,existing.machine_op2,existing.machine_op3,existing.machine_op4,existing.finishing,existing.active_in_bom,existing.part_id,existing.assembly_id)
          is distinct from row(excluded.configuration,excluded.required_quantity,excluded.bom_positions,excluded.onshape_url,excluded.source_document,excluded.source_root,excluded.source_assembly_revision,excluded.required_part_revision,excluded.machine_op1,excluded.machine_op2,excluded.machine_op3,excluded.machine_op4,excluded.finishing,excluded.active_in_bom,excluded.part_id,excluded.assembly_id),
        last_synced_at=case when v ? 'last_synced_at' then excluded.last_synced_at else existing.last_synced_at end,
        updated_at=clock_timestamp();
    end loop;

    for v in select value from jsonb_array_elements(p_payload->'operations') loop
      if not exists(select 1 from jsonb_array_elements(p_payload->'requirements') r
        where r->>'production_key'=v->>'production_key') then
        raise exception 'Work row requirement is absent from successful scope';
      end if;
      select id into strict requirement_id_value from manufacturing.requirements
        where production_key=v->>'production_key';
      v:=v || jsonb_build_object('requirement_id',requirement_id_value);
      if v->>'work_type' is distinct from 'Manufacturing'
        or v->>'operation_number' not in ('OP1','OP2','OP3','OP4')
        or v->>'operation_key' is distinct from (v->>'production_key') || '|' || (v->>'operation_number') then
        raise exception 'Invalid released operation identity';
      end if;
      -- Lock all matches before validating identity. Never pick one duplicate
      -- arbitrarily, combine quantities, or move another requirement's shop work.
      perform o.id from manufacturing.operations o where o.operation_key=v->>'operation_key' for update;
      if exists(select 1 from manufacturing.operations o where o.operation_key=v->>'operation_key'
        and (o.requirement_id is distinct from requirement_id_value
          or coalesce(o.work_type,'Manufacturing')<>'Manufacturing')) then
        raise exception 'Existing operation key has incompatible requirement or work type';
      end if;
      update manufacturing.operations o set
        operation_number=v->>'operation_number',
        machine=case when v ? 'machine' then v->>'machine' else o.machine end,
        active_in_routing=case when v ? 'active_in_routing' then (v->>'active_in_routing')::boolean else o.active_in_routing end,
        work_type='Manufacturing',updated_at=clock_timestamp()
      where o.operation_key=v->>'operation_key';
      get diagnostics operation_matches = row_count;
      if operation_matches=0 then
        insert into manufacturing.operations(operation_key,operation_number,machine,active_in_routing,work_type,requirement_id)
        select operation_key,operation_number,machine,active_in_routing,work_type,requirement_id
        from jsonb_populate_record(null::manufacturing.operations,v);
      elsif operation_matches>1 then
        duplicate_operations_preserved:=duplicate_operations_preserved+operation_matches-1;
      end if;
    end loop;

    for v in select value from jsonb_array_elements(p_payload->'finishing') loop
      if not exists(select 1 from jsonb_array_elements(p_payload->'requirements') r
        where r->>'production_key'=v->>'production_key') then
        raise exception 'Work row requirement is absent from successful scope';
      end if;
      select id into strict requirement_id_value from manufacturing.requirements
        where production_key=v->>'production_key';
      v:=v || jsonb_build_object('requirement_id',requirement_id_value);
      if v->>'color' not in ('Red','Black') or not exists(
        select 1 from manufacturing.requirements r where r.id=requirement_id_value
          and r.finishing=v->>'color' and r.required_quantity=(v->>'required_quantity')::numeric) then
        raise exception 'Finishing differs from its requirement';
      end if;
      v:=v || jsonb_build_object('last_synced_at',clock_timestamp());
      insert into manufacturing.finishing as existing(production_key, color, required_quantity, active, requirement_id, last_synced_at)
      select production_key, color, required_quantity, active, requirement_id, last_synced_at from jsonb_populate_record(null::manufacturing.finishing,v)
      on conflict (production_key) where production_key is not null and production_key<>'' do update set
        color=case when v ? 'color' then excluded.color else existing.color end,
        required_quantity=case when v ? 'required_quantity' then excluded.required_quantity else existing.required_quantity end,
        active=case when v ? 'active' then excluded.active else existing.active end,
        requirement_id=case when v ? 'requirement_id' then excluded.requirement_id else existing.requirement_id end,
        last_synced_at=case when v ? 'last_synced_at' then excluded.last_synced_at else existing.last_synced_at end,
        updated_at=clock_timestamp();
    end loop;

    -- Source root, then unambiguous legacy key/assembly fallback. Never infer scope from a shared part.
    update manufacturing.requirements r set active_in_bom=false, engineering_changed=true,
      last_synced_at=clock_timestamp(), updated_at=clock_timestamp()
    where r.id in (select r.id from manufacturing.requirements r
      left join manufacturing.assemblies a on a.id=r.assembly_id where coalesce(nullif(r.source_root,''), case when cardinality(string_to_array(r.production_key,'|'))>=5 then split_part(r.production_key,'|',1) end, a.assembly_number)=any(roots))
      and r.active_in_bom is distinct from false
      and not exists(select 1 from jsonb_array_elements(p_payload->'requirements') desired where desired->>'production_key'=r.production_key);
    get diagnostics requirements_deactivated = row_count;

    update manufacturing.operations o set active_in_routing=false, updated_at=clock_timestamp()
    from manufacturing.requirements r left join manufacturing.assemblies a on a.id=r.assembly_id
    where o.requirement_id=r.id and coalesce(nullif(r.source_root,''), case when cardinality(string_to_array(r.production_key,'|'))>=5 then split_part(r.production_key,'|',1) end, a.assembly_number)=any(roots)
      and o.active_in_routing is distinct from false
      and not exists(select 1 from jsonb_array_elements(p_payload->'operations') desired where desired->>'operation_key'=o.operation_key);
    get diagnostics operations_deactivated = row_count;

    update manufacturing.finishing f set active=false, last_synced_at=clock_timestamp(), updated_at=clock_timestamp()
    from manufacturing.requirements r left join manufacturing.assemblies a on a.id=r.assembly_id
    where f.requirement_id=r.id and coalesce(nullif(r.source_root,''), case when cardinality(string_to_array(r.production_key,'|'))>=5 then split_part(r.production_key,'|',1) end, a.assembly_number)=any(roots)
      and f.active is distinct from false
      and not exists(select 1 from jsonb_array_elements(p_payload->'finishing') desired where desired->>'production_key'=f.production_key);
    get diagnostics finishing_deactivated = row_count;

    if coalesce((p_payload->>'discovery_complete')::boolean,false) and coalesce(p_payload->>'discovery_master','')<>'' then
      update manufacturing.assemblies set integration_status='Discovered — Master Unreleased', updated_at=clock_timestamp()
      where discovery_master=p_payload->>'discovery_master' and integration_status='Missing from Main — Review'
        and exists(select 1 from jsonb_array_elements_text(p_payload->'discovered_roots') n where n=assembly_number);
      update manufacturing.assemblies set integration_status='Missing from Main — Review', updated_at=clock_timestamp()
      where discovery_master=p_payload->>'discovery_master' and not exists(
        select 1 from jsonb_array_elements_text(p_payload->'discovered_roots') n where n=assembly_number);
    end if;

    for g in select value from jsonb_array_elements(p_payload->'attachments') loop
      if coalesce(g->>'kind','') not in ('drawing-pdf','step') or coalesce(g->>'export_key','') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(g->'files') is distinct from 'array' or jsonb_array_length(g->'files')=0 then
        raise exception 'Invalid attachment group';
      end if;
      if not exists(select 1 from jsonb_array_elements(p_payload->'parts') p where p->>'part_number'=g->>'part_number') then
        raise exception 'Attachment part is absent from payload';
      end if;
      select id into strict part_id_value from manufacturing.parts where part_number=g->>'part_number';
      position_value:=0;
      for f in select value from jsonb_array_elements(g->'files') loop
        if coalesce(f->>'sha256','') !~ '^[0-9a-f]{64}$'
          or f->>'storage_bucket' is distinct from 'manufacturing-files'
          or f->>'storage_path' is distinct from 'sha256/' || substr(f->>'sha256',1,2) || '/' ||
            (f->>'sha256') || (case g->>'kind' when 'drawing-pdf' then '.pdf' else '.step' end)
          or coalesce(f->>'source_url','') !~ '^https://'
          or coalesce(f->>'original_name','')=''
          or f->>'content_type' is distinct from (case g->>'kind' when 'drawing-pdf' then 'application/pdf' else 'application/step' end)
          or (f->>'byte_size')::bigint is null or (f->>'byte_size')::bigint<0
          or (f->>'verified_at')::timestamptz is null or jsonb_typeof(f->'source_metadata') is distinct from 'object' then
          raise exception 'Invalid verified attachment';
        end if;
        -- The bucket must already be private, and the uploaded object must exist.
        if not exists(select 1 from storage.buckets b join storage.objects o on o.bucket_id=b.id
          where b.id='manufacturing-files' and not b.public and o.name=f->>'storage_path') then
          raise exception 'Verified attachment object is missing or bucket is public';
        end if;
        insert into manufacturing.attachments(part_id,kind,position,source_field_id,source_url,source_metadata,
          original_name,content_type,byte_size,sha256,storage_bucket,storage_path,verified_at)
        values(part_id_value,g->>'kind',position_value,null,f->>'source_url',f->'source_metadata',
          f->>'original_name',f->>'content_type',(f->>'byte_size')::bigint,f->>'sha256',f->>'storage_bucket',
          f->>'storage_path',(f->>'verified_at')::timestamptz)
        on conflict(part_id,kind,position) do update set
          source_field_id=null,source_url=excluded.source_url,source_metadata=excluded.source_metadata,
          original_name=excluded.original_name,content_type=excluded.content_type,byte_size=excluded.byte_size,
          sha256=excluded.sha256,storage_bucket=excluded.storage_bucket,storage_path=excluded.storage_path,
          verified_at=excluded.verified_at;
        position_value:=position_value+1;
      end loop;
      delete from manufacturing.attachments where part_id=part_id_value and kind=g->>'kind' and position>=position_value;
      if g->>'kind'='drawing-pdf' then
        update manufacturing.parts set drawing_export_key=g->>'export_key', drawing_files=g->'files' where id=part_id_value;
      else
        update manufacturing.parts set step_export_key=g->>'export_key', step_files=g->'files' where id=part_id_value;
      end if;
    end loop;
    if duplicate_operations_preserved>0 then
      p_payload:=jsonb_set(p_payload,'{warnings}',(p_payload->'warnings') || jsonb_build_array(
        format('Preserved %s existing duplicate operation rows and their shop work',duplicate_operations_preserved)));
    end if;
    result_summary:=jsonb_build_object('status',case when jsonb_array_length(p_payload->'warnings')>0 then 'partial' else 'success' end,
      'committed',true,'warnings',p_payload->'warnings','source_rows',p_payload->'source_rows',
      'synced_roots',p_payload->'synced_roots','deactivated',requirements_deactivated,
      'operations_deactivated',operations_deactivated,'finishing_deactivated',finishing_deactivated,
      'duplicate_operations_preserved',duplicate_operations_preserved,
      'file_groups_uploaded',jsonb_array_length(p_payload->'attachments'),'file_groups_cached',p_payload->'file_groups_cached');
  exception when others then
    get stacked diagnostics error_message = message_text;
    result_summary:=jsonb_build_object('status','failed','committed',false,'error',error_message);
  end;
  update manufacturing.engineering_sync_runs set status=result_summary->>'status',summary=result_summary,
    finished_at=clock_timestamp() where id=p_run_id;
  return result_summary;
end;
$$;

revoke all on function public.manufacturing_begin_engineering_sync(uuid,text) from public, anon, authenticated;
grant execute on function public.manufacturing_begin_engineering_sync(uuid,text) to service_role;
revoke all on function public.manufacturing_finish_engineering_sync(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.manufacturing_finish_engineering_sync(uuid,text,jsonb) to service_role;
revoke all on function public.manufacturing_engineering_sync_state() from public, anon, authenticated;
grant execute on function public.manufacturing_engineering_sync_state() to service_role;
revoke all on function public.manufacturing_engineering_file_state(text[]) from public, anon, authenticated;
grant execute on function public.manufacturing_engineering_file_state(text[]) to service_role;
revoke all on function public.manufacturing_apply_engineering_sync(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.manufacturing_apply_engineering_sync(uuid,jsonb) to service_role;

commit;
