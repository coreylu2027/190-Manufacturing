-- Explicit additive installation; does not enable production writes or modify data.
begin;
create table manufacturing.write_control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into manufacturing.write_control default values;
create table manufacturing.write_requests (
  request_id uuid primary key, actor uuid not null references auth.users(id),
  action text not null, payload_hash text not null, result jsonb,
  committed_at timestamptz not null default clock_timestamp()
);
create table manufacturing.write_history (
  request_id uuid not null references manufacturing.write_requests(request_id),
  entity text not null, row_id bigint not null, before_row jsonb not null, after_row jsonb not null,
  primary key(request_id, entity, row_id)
);
create table manufacturing.quality_review_retractions (
  review_id bigint primary key references public.quality_control(id) on delete restrict,
  request_id uuid not null references manufacturing.write_requests(request_id),
  retracted_by uuid not null references auth.users(id), retracted_at timestamptz not null default clock_timestamp()
);
alter table manufacturing.write_control enable row level security;
alter table manufacturing.write_requests enable row level security;
alter table manufacturing.write_history enable row level security;
alter table manufacturing.quality_review_retractions enable row level security;
revoke all on manufacturing.write_control, manufacturing.write_requests, manufacturing.write_history,
  manufacturing.quality_review_retractions from public, anon, authenticated, service_role;

create function manufacturing.prevent_history_change() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Manufacturing history is append only'; end;
$$;
create trigger immutable before update or delete or truncate on manufacturing.write_requests
  for each statement execute function manufacturing.prevent_history_change();
create trigger immutable before update or delete or truncate on manufacturing.write_history
  for each statement execute function manufacturing.prevent_history_change();
create trigger immutable before update or delete or truncate on manufacturing.quality_review_retractions
  for each statement execute function manufacturing.prevent_history_change();
revoke all on function manufacturing.prevent_history_change() from public, anon, authenticated, service_role;

-- One statement snapshot includes every routing row, even duplicates. The token
-- detects edits, inserted/deleted rows and QC changes between planning and commit.
create function manufacturing.write_snapshot() returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('rows', jsonb_build_object(
    'operations', coalesce((select jsonb_agg(to_jsonb(o) order by id) from manufacturing.operations o), '[]'),
    'requirements', coalesce((select jsonb_agg(to_jsonb(r) order by id) from manufacturing.requirements r), '[]'),
    'finishing', coalesce((select jsonb_agg(to_jsonb(f) order by id) from manufacturing.finishing f), '[]')),
    'reviews', coalesce((select jsonb_agg(to_jsonb(q) order by id) from public.quality_control q), '[]'),
    'retractions', coalesce((select jsonb_agg(to_jsonb(v) order by review_id) from manufacturing.quality_review_retractions v), '[]'));
$$;
revoke all on function manufacturing.write_snapshot() from public, anon, authenticated, service_role;
create function public.manufacturing_write_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select state || jsonb_build_object('token', md5(state::text)) from (select manufacturing.write_snapshot() state) s;
$$;
revoke all on function public.manufacturing_write_state() from public, anon, authenticated;
grant execute on function public.manufacturing_write_state() to service_role;

create function public.manufacturing_commit(p_request_id uuid, p_actor uuid, p_action text,
  p_expected text, p_changes jsonb, p_qc jsonb, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  prior manufacturing.write_requests; fingerprint text; change jsonb; entity text; patch jsonb;
  row_id bigint; allowed text[]; assignments text; before_row jsonb; after_row jsonb;
  ledger jsonb; allocation jsonb; ordinal integer; claimed numeric; completed numeric;
  target_requirement_id bigint; target_review_id bigint; review_result text; actor_role text;
begin
  set local lock_timeout = '5s';
  -- Serialize this small shop's transactions and exclude direct table writers.
  -- Lock order is fixed; all reads used for the CAS happen after acquiring locks.
  lock table manufacturing.write_control, manufacturing.write_requests, manufacturing.requirements,
    manufacturing.operations, manufacturing.finishing, manufacturing.operation_allocations,
    public.quality_control, manufacturing.quality_review_retractions in share row exclusive mode;
  if not exists(select 1 from manufacturing.write_control where enabled) then
    raise exception 'Supabase manufacturing writes are disabled' using errcode = '42501';
  end if;
  select role::text into actor_role from public.profiles where id = p_actor and approved for share;
  if actor_role is null then raise exception 'Approved actor required' using errcode = '42501'; end if;
  if p_action not in ('claim','release','complete','undo_complete','steal','patch_operation','cam_handoff',
      'finishing_claim','finishing_release','finishing_complete','finishing_undo_complete','rename','qc_review','qc_undo')
      or p_request_id is null then raise exception 'Invalid manufacturing action'; end if;
  if p_action in ('patch_operation','cam_handoff','qc_review','qc_undo') and actor_role <> 'admin' then
    raise exception 'Administrator required' using errcode = '42501';
  end if;
  fingerprint := md5(jsonb_build_array(p_actor,p_action,p_expected,p_changes,p_qc,p_result)::text);
  select * into prior from manufacturing.write_requests where request_id=p_request_id;
  if found then
    if prior.payload_hash <> fingerprint then raise exception 'Request ID reused with different payload' using errcode='40001'; end if;
    return prior.result;
  end if;
  if p_expected is distinct from md5(manufacturing.write_snapshot()::text) then
    raise exception 'Manufacturing state changed' using errcode='40001';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'Invalid changes'; end if;
  if (p_action in ('qc_review','qc_undo')) <> (p_qc is not null) then raise exception 'QC action must be atomic'; end if;
  insert into manufacturing.write_requests(request_id,actor,action,payload_hash,result)
    values(p_request_id,p_actor,p_action,fingerprint,p_result);
  for change in select value from jsonb_array_elements(p_changes) loop
    entity := change->>'entity'; row_id := (change->>'id')::bigint; patch := change->'patch';
    allowed := case entity
      when 'operations' then array['status','machinist','started_at','completed_at','claimed_quantity','completed_quantity','quantity_ledger','cam_program_path','cam_notes']
      when 'requirements' then array['status','machinist','qc_outcome','qc_notes','qc_reviewed_by','qc_reviewed_at','disposition']
      when 'finishing' then array['machinist'] else null end;
    if allowed is null or jsonb_typeof(patch) is distinct from 'object' or patch = '{}'::jsonb then raise exception 'Invalid production patch'; end if;
    if exists(select 1 from jsonb_object_keys(patch) k where not k = any(allowed)) then
      raise exception 'Engineering, provenance and location fields cannot be modified';
    end if;
    if p_action not in ('qc_review','qc_undo') and patch ?| array['qc_notes','qc_reviewed_by','qc_reviewed_at'] then raise exception 'QC review required'; end if;
    execute format('select to_jsonb(r) from manufacturing.%I r where id=$1',entity) into before_row using row_id;
    if before_row is null then raise exception 'Manufacturing row missing' using errcode='40001'; end if;
    select string_agg(format('%I = (jsonb_populate_record(null::manufacturing.%I, $1)).%I',k,entity,k), ', ' order by k)
      into assignments from jsonb_object_keys(patch) k;
    execute format('update manufacturing.%I set %s, updated_at=clock_timestamp() where id=$2 returning to_jsonb(%I.*)',entity,assignments,entity)
      into after_row using patch,row_id;
    if entity='operations' and patch ? 'quantity_ledger' then
      ledger := (after_row->>'quantity_ledger')::jsonb;
      if jsonb_typeof(ledger) is distinct from 'array' then raise exception 'Invalid quantity ledger'; end if;
      claimed:=0; completed:=0; ordinal:=0;
      delete from manufacturing.operation_allocations where operation_id=row_id;
      for allocation in select value from jsonb_array_elements(ledger) loop
        if coalesce(allocation->>'userId','')='' or coalesce(allocation->>'name','')=''
          or jsonb_typeof(allocation->'claimed') is distinct from 'number'
          or jsonb_typeof(allocation->'completed') is distinct from 'number'
          or (allocation->>'claimed')::numeric < 0 or (allocation->>'completed')::numeric < 0
          or trunc((allocation->>'claimed')::numeric) <> (allocation->>'claimed')::numeric
          or trunc((allocation->>'completed')::numeric) <> (allocation->>'completed')::numeric then raise exception 'Invalid allocation'; end if;
        claimed:=claimed+(allocation->>'claimed')::numeric; completed:=completed+(allocation->>'completed')::numeric;
        insert into manufacturing.operation_allocations values(row_id,ordinal,allocation->>'userId',allocation->>'name',
          (allocation->>'claimed')::numeric,(allocation->>'completed')::numeric,allocation);
        ordinal:=ordinal+1;
      end loop;
      if claimed is distinct from (after_row->>'claimed_quantity')::numeric or completed is distinct from (after_row->>'completed_quantity')::numeric then
        raise exception 'Allocation totals do not match operation quantities'; end if;
    end if;
    insert into manufacturing.write_history values(p_request_id,entity,row_id,before_row,after_row);
  end loop;
  if p_qc is not null then
    target_requirement_id := (p_qc->>'requirement_id')::bigint;
    if not exists(select 1 from manufacturing.requirements where id=target_requirement_id) then raise exception 'QC requirement missing'; end if;
    if p_action='qc_review' then
      if p_qc->>'result' not in ('passed','failed') then raise exception 'Invalid QC result'; end if;
      insert into public.quality_control(production_requirement_id,operation_id,result,notes,reviewed_by,reviewed_at,updated_at)
      values(target_requirement_id,null,(p_qc->>'result')::public.quality_result,coalesce(p_qc->>'notes',''),p_actor,
        (p_qc->>'reviewed_at')::timestamptz,clock_timestamp());
    else
      select q.id,q.result::text into target_review_id,review_result from public.quality_control q
        where q.production_requirement_id=target_requirement_id or (q.production_requirement_id is null and exists
          (select 1 from manufacturing.operations o where o.id=q.operation_id and o.requirement_id=target_requirement_id))
        order by q.reviewed_at desc,q.id desc limit 1;
      if review_result is distinct from 'passed' or exists(select 1 from manufacturing.quality_review_retractions r where r.review_id=target_review_id) then
        raise exception 'Only the latest passed QC review can be undone' using errcode='40001'; end if;
      insert into manufacturing.quality_review_retractions values(target_review_id,p_request_id,p_actor,clock_timestamp());
    end if;
  end if;
  return p_result;
end;
$$;
revoke all on function public.manufacturing_commit(uuid,uuid,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.manufacturing_commit(uuid,uuid,text,text,jsonb,jsonb,jsonb) to service_role;
commit;
