-- Apply after 20260905_part_locations.sql. Adds rejected-unit audit data,
-- removes legacy rework states, and keeps QC quantity writes atomic.
begin;

alter table public.quality_control
  add column if not exists rejected_quantity integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quality_control_rejected_quantity_positive'
      and conrelid = 'public.quality_control'::regclass
  ) then
    alter table public.quality_control
      add constraint quality_control_rejected_quantity_positive
      check (rejected_quantity is null or rejected_quantity > 0);
  end if;
end;
$$;

update public.quality_control q
set rejected_quantity = greatest(1, trunc(coalesce(r.required_quantity, 1)))::integer
from manufacturing.requirements r
where q.result = 'failed'
  and q.rejected_quantity is null
  and r.id = coalesce(
    q.production_requirement_id,
    (select o.requirement_id from manufacturing.operations o where o.id = q.operation_id)
  );

create temporary table qc_legacy_reset_operations on commit drop as
select
  o.id,
  min(
    coalesce((regexp_match(o.operation_number, '^OP([0-9]+)$', 'i'))[1]::integer, 2147483647)
  ) over (partition by o.requirement_id) as first_stage,
  coalesce((regexp_match(o.operation_number, '^OP([0-9]+)$', 'i'))[1]::integer, 2147483647) as operation_stage
from manufacturing.operations o
left join manufacturing.requirements r on r.id = o.requirement_id
where o.active_in_routing
  and o.work_type = 'Manufacturing'
  and lower(trim(coalesce(o.machine, ''))) <> 'threaded insert'
  and (
    o.status = 'Needs Rework'
    or (r.status = 'Needs Rework' and r.qc_outcome = 'Failed')
  );

delete from manufacturing.operation_allocations a
using qc_legacy_reset_operations reset
where a.operation_id = reset.id;

update manufacturing.operations o
set status = case when reset.operation_stage = reset.first_stage then 'Ready' else 'Planned' end,
    machinist = '',
    claimed_quantity = 0,
    completed_quantity = 0,
    quantity_ledger = '[]',
    completed_at = null,
    updated_at = clock_timestamp()
from qc_legacy_reset_operations reset
where o.id = reset.id;

delete from manufacturing.operation_allocations a
using manufacturing.operations o
where a.operation_id = o.id
  and o.status = 'Needs Rework';

update manufacturing.operations
set status = 'Ready',
    claimed_quantity = 0,
    completed_quantity = 0,
    quantity_ledger = '[]',
    machinist = '',
    completed_at = null,
    updated_at = clock_timestamp()
where status = 'Needs Rework';

update manufacturing.requirements
set status = 'Ready for Manufacturing',
    updated_at = clock_timestamp()
where status = 'Needs Rework';

create or replace function public.manufacturing_commit_with_qc_quantities(
  p_request_id uuid, p_actor uuid, p_action text, p_expected text,
  p_changes jsonb, p_qc jsonb, p_result jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  committed_result jsonb;
  target_requirement_id bigint;
  maximum_quantity integer;
begin
  if p_action = 'qc_review' then
    target_requirement_id := (p_qc->>'requirement_id')::bigint;
    select greatest(1, trunc(coalesce(r.required_quantity, 1)))::integer
      into maximum_quantity
    from manufacturing.requirements r
    where r.id = target_requirement_id;

    if maximum_quantity is null then
      raise exception 'QC requirement missing';
    end if;
    if p_qc->>'result' = 'failed' and (
      btrim(coalesce(p_qc->>'notes', '')) = ''
      or jsonb_typeof(p_qc->'rejected_quantity') is distinct from 'number'
      or (p_qc->>'rejected_quantity')::numeric < 1
      or trunc((p_qc->>'rejected_quantity')::numeric) <> (p_qc->>'rejected_quantity')::numeric
      or (p_qc->>'rejected_quantity')::numeric > maximum_quantity
    ) then
      raise exception 'Invalid QC failure details';
    end if;
    if p_qc->>'result' = 'passed' and p_qc->>'rejected_quantity' is not null then
      raise exception 'Passed QC cannot reject a quantity';
    end if;
  end if;

  committed_result := public.manufacturing_commit_with_locations(
    p_request_id, p_actor, p_action, p_expected, p_changes, p_qc, p_result
  );

  if p_action = 'qc_review' and p_qc->>'result' = 'failed' then
    update public.quality_control
    set rejected_quantity = (p_qc->>'rejected_quantity')::integer,
        updated_at = clock_timestamp()
    where production_requirement_id = target_requirement_id
      and reviewed_by = p_actor
      and reviewed_at = (p_qc->>'reviewed_at')::timestamptz
      and result = 'failed';
    if not found then
      raise sqlstate 'PT409' using message = 'QC failure record missing';
    end if;
  end if;

  return committed_result;
end;
$$;

revoke all on function public.manufacturing_commit_with_qc_quantities(uuid,uuid,text,text,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.manufacturing_commit_with_qc_quantities(uuid,uuid,text,text,jsonb,jsonb,jsonb)
  to service_role;

commit;
