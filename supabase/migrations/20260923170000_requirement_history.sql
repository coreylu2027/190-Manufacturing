-- Read-only timeline for one production requirement: every recorded write that
-- touched its requirement, operation, or finishing rows (plus part-level
-- corrections, which apply to every requirement for the part), its QC reviews,
-- and Onshape-correction events. Writes made before the move to Supabase and
-- the engineering sync's own writes are not in write_history, so they are absent.
create index if not exists write_history_entity_row_idx on manufacturing.write_history(entity, row_id);

create or replace function public.manufacturing_requirement_history(p_requirement_id bigint, p_limit integer default 200)
returns jsonb language sql stable security definer set search_path = '' as $$
  with target as (
    select id, part_id from manufacturing.requirements where id = p_requirement_id
  ), operation_ids as (
    select id from manufacturing.operations where requirement_id = p_requirement_id
  ), finishing_ids as (
    select id from manufacturing.finishing where requirement_id = p_requirement_id
  ), touched as (
    select h.* from manufacturing.write_history h
    where (h.entity = 'requirements' and h.row_id = p_requirement_id)
       or (h.entity = 'operations' and h.row_id in (select id from operation_ids))
       or (h.entity = 'finishing' and h.row_id in (select id from finishing_ids))
       or (h.entity = 'parts' and h.row_id = (select part_id from target))
  ), events as (
    select e.* from manufacturing.engineering_override_events e
    where (e.entity = 'requirements' and e.row_id = p_requirement_id)
       or (e.entity = 'parts' and e.row_id = (select part_id from target))
  ), requests as (
    select w.request_id, w.action, w.committed_at, w.actor from manufacturing.write_requests w
    where w.request_id in (select request_id from touched union select request_id from events where request_id is not null)
    order by w.committed_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
  )
  select jsonb_build_object(
    'requirementId', p_requirement_id,
    'writes', coalesce((select jsonb_agg(jsonb_build_object(
        'requestId', r.request_id, 'action', r.action, 'at', r.committed_at,
        'actor', coalesce(p.display_name, 'Unknown user'),
        'rows', coalesce((select jsonb_agg(jsonb_build_object(
            'entity', h.entity, 'rowId', h.row_id, 'created', h.before_row = '{}'::jsonb,
            'operationNumber', coalesce(h.after_row->>'operation_number', h.before_row->>'operation_number'),
            'machine', coalesce(h.after_row->>'machine', h.before_row->>'machine'),
            'workType', coalesce(h.after_row->>'work_type', h.before_row->>'work_type'),
            'changes', (select coalesce(jsonb_object_agg(k, jsonb_build_array(h.before_row->k, h.after_row->k)), '{}'::jsonb)
              from jsonb_object_keys(h.before_row || h.after_row) k
              where h.before_row->k is distinct from h.after_row->k
                and k not in ('id','baserow_id','created_at','updated_at','source_row','source_snapshot_id','last_synced_at'))
          ) order by h.entity, h.row_id) from touched h where h.request_id = r.request_id), '[]'::jsonb),
        'corrections', coalesce((select jsonb_agg(jsonb_build_object(
            'entity', e.entity, 'field', e.field, 'action', e.action, 'value', e.value,
            'syncedValue', e.synced_value, 'reason', e.reason) order by e.id)
          from events e where e.request_id = r.request_id), '[]'::jsonb)
      ) order by r.committed_at desc, r.request_id)
      from requests r left join public.profiles p on p.id = r.actor), '[]'::jsonb),
    'syncEvents', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'entity', e.entity, 'field', e.field, 'action', e.action, 'value', e.value,
        'syncedValue', e.synced_value, 'at', e.at) order by e.at desc, e.id desc)
      from events e where e.request_id is null), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object(
        'id', q.id, 'result', q.result, 'notes', q.notes, 'rejectedQuantity', q.rejected_quantity,
        'at', q.reviewed_at, 'reviewer', coalesce(reviewer.display_name, 'Unknown user'),
        'retractedAt', x.retracted_at, 'retractedBy', retractor.display_name) order by q.reviewed_at desc, q.id desc)
      from public.quality_control q
      left join public.profiles reviewer on reviewer.id = q.reviewed_by
      left join manufacturing.quality_review_retractions x on x.review_id = q.id
      left join public.profiles retractor on retractor.id = x.retracted_by
      where q.production_requirement_id = p_requirement_id
         or (q.production_requirement_id is null and q.operation_id in (select id from operation_ids))), '[]'::jsonb)
  )
  where exists(select 1 from target);
$$;
revoke all on function public.manufacturing_requirement_history(bigint, integer) from public, anon, authenticated;
grant execute on function public.manufacturing_requirement_history(bigint, integer) to service_role;
