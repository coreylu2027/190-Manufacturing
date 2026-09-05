\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-000000000190', 'admin@example.test', '{"full_name":"Test Admin"}'),
  ('00000000-0000-4000-8000-000000000198', 'machinist@example.test', '{"full_name":"Test Machinist"}'),
  ('00000000-0000-4000-8000-000000000199', 'pending@example.test', '{"full_name":"Pending User"}');
update public.profiles
set display_name = 'Test Admin', role = 'admin', approved = true
where id = '00000000-0000-4000-8000-000000000190';
update public.profiles
set display_name = 'Test Machinist', role = 'machinist', approved = true
where id = '00000000-0000-4000-8000-000000000198';

insert into manufacturing.requirements (
  id, source_row, production_key, required_quantity, finishing, active_in_bom,
  status, machinist, qc_outcome, qc_notes, qc_reviewed_by
) values (
  -190, '{"id":-190,"Status":{"value":"Ready for Manufacturing"},"Required Quantity":2,"Finishing":{"value":"None"},"QC Outcome":{"value":"Not Inspected"}}',
  'write-test', 2, 'None', true, 'Ready for Manufacturing', '', 'Not Inspected', '', ''
);
insert into manufacturing.operations (
  id, source_row, operation_key, requirement_id, operation_number, machine,
  work_type, active_in_routing, status, machinist, claimed_quantity,
  completed_quantity, quantity_ledger
) values (
  -190, '{"id":-190,"Operation":"write-test|OP1","Production Requirement":[{"id":-190,"value":"P-190 — Test [A-190]"}],"Operation Number":{"value":"OP1"},"Machine":{"value":"Mill"},"Work Type":{"value":"Manufacturing"},"Active in Routing":true,"Status":{"value":"Ready"},"Machinist":"","Claimed Quantity":0,"Completed Quantity":0,"Quantity Ledger":""}',
  'write-test|OP1', -190, 'OP1', 'Mill', 'Manufacturing', true, 'Ready', '', 0, 0, ''
);
insert into manufacturing.finishing (
  id, source_row, production_key, requirement_id, active, machinist
) values (
  -190, '{"id":-190,"Production Key":"write-test","Production Requirement":[{"id":-190,"value":"P-190 — Test [A-190]"}],"Active":true,"Machinist":""}',
  'write-test', -190, true, ''
);
update manufacturing.write_control set enabled = true;

do $test$
declare
  actor constant uuid := '00000000-0000-4000-8000-000000000190';
  request constant uuid := '00000000-0000-4000-8000-000000000191';
  state jsonb;
  result jsonb;
  rejected boolean := false;
begin
  state := public.manufacturing_write_state();
  result := public.manufacturing_commit(
    request, actor, 'claim', state->>'token',
    jsonb_build_array(
      jsonb_build_object('entity','operations','id',-190,'patch',jsonb_build_object(
        'status','In Progress','machinist','Test Admin (1)','claimed_quantity',1,
        'completed_quantity',0,'quantity_ledger','[{"userId":"00000000-0000-4000-8000-000000000190","name":"Test Admin","claimed":1,"completed":0}]',
        'started_at','2026-09-05T00:00:00Z')),
      jsonb_build_object('entity','requirements','id',-190,'patch',jsonb_build_object(
        'status','Manufacturing in Progress','machinist','Test Admin (1)'))
    ), null, '{"id":-190,"status":"In Progress"}'
  );
  if result <> '{"id":-190,"status":"In Progress"}'::jsonb then
    raise exception 'Unexpected commit result';
  end if;
  if (select claimed_quantity from manufacturing.operations where id=-190) <> 1
    or (select count(*) from manufacturing.operation_allocations where operation_id=-190) <> 1
    or (select count(*) from manufacturing.write_history where request_id=request) <> 2 then
    raise exception 'Claim was not committed completely';
  end if;

  -- An identical retry returns the stored result before checking its stale token.
  if public.manufacturing_commit(
    request, actor, 'claim', state->>'token',
    jsonb_build_array(
      jsonb_build_object('entity','operations','id',-190,'patch',jsonb_build_object(
        'status','In Progress','machinist','Test Admin (1)','claimed_quantity',1,
        'completed_quantity',0,'quantity_ledger','[{"userId":"00000000-0000-4000-8000-000000000190","name":"Test Admin","claimed":1,"completed":0}]',
        'started_at','2026-09-05T00:00:00Z')),
      jsonb_build_object('entity','requirements','id',-190,'patch',jsonb_build_object(
        'status','Manufacturing in Progress','machinist','Test Admin (1)'))
    ), null, '{"id":-190,"status":"In Progress"}'
  ) <> result then raise exception 'Idempotent retry changed its result'; end if;

  begin
    perform public.manufacturing_commit(
      '00000000-0000-4000-8000-000000000192', actor, 'claim', state->>'token',
      '[]', null, '{}'
    );
  exception when serialization_failure then rejected := true; end;
  if not rejected then raise exception 'Stale concurrent edit was accepted'; end if;
end;
$test$;

do $test$
declare
  actor constant uuid := '00000000-0000-4000-8000-000000000190';
  mover constant uuid := '00000000-0000-4000-8000-000000000198';
  pending_actor constant uuid := '00000000-0000-4000-8000-000000000199';
  review_request constant uuid := '00000000-0000-4000-8000-000000000193';
  undo_request constant uuid := '00000000-0000-4000-8000-000000000194';
  failed_request constant uuid := '00000000-0000-4000-8000-000000000195';
  location_request constant uuid := '00000000-0000-4000-8000-000000000196';
  rejected_location_request constant uuid := '00000000-0000-4000-8000-000000000197';
  state jsonb;
  rejected boolean := false;
begin
  update manufacturing.operations set status='Complete', claimed_quantity=0,
    completed_quantity=2, quantity_ledger='[{"userId":"00000000-0000-4000-8000-000000000190","name":"Test Admin","claimed":0,"completed":2}]'
    where id=-190;
  update manufacturing.requirements set status='Ready for QC', machinist='Test Admin (2)'
    where id=-190;

  state := public.manufacturing_write_state();
  perform public.manufacturing_commit_with_locations(
    review_request, actor, 'qc_review', state->>'token',
    jsonb_build_array(jsonb_build_object('entity','requirements','id',-190,'patch',jsonb_build_object(
      'status','Complete','qc_outcome','Passed','qc_notes','Looks good',
      'qc_reviewed_by','Test Admin','qc_reviewed_at','2026-09-05T00:01:00Z'))),
    jsonb_build_object('requirement_id',-190,'result','passed','notes','Looks good','reviewed_at','2026-09-05T00:01:00Z','location','Clarke 1'),
    '{"requirementId":-190,"result":"passed","notes":"Looks good"}'
  );
  if (select status from manufacturing.requirements where id=-190) <> 'Complete'
    or (select count(*) from public.quality_control where production_requirement_id=-190 and result='passed' and storage_location='Clarke 1') <> 1 then
    raise exception 'QC review was not committed atomically';
  end if;

  state := public.manufacturing_write_state();
  begin
    perform public.manufacturing_commit_with_locations(
      rejected_location_request, pending_actor, 'qc_location', state->>'token', '[]',
      jsonb_build_object('requirement_id',-190,'location','Shelf 3','location_updated_at','2026-09-05T00:01:20Z'), '{}'
    );
  exception when insufficient_privilege then rejected := true; end;
  if not rejected then raise exception 'Unapproved user changed a QC location'; end if;

  state := public.manufacturing_write_state();
  perform public.manufacturing_commit_with_locations(
    location_request, mover, 'qc_location', state->>'token', '[]',
    jsonb_build_object('requirement_id',-190,'location','Shelf 3','location_updated_at','2026-09-05T00:01:30Z'),
    '{"storageLocation":"Shelf 3","locationUpdatedBy":"Test Machinist","locationUpdatedAt":"2026-09-05T00:01:30Z"}'
  );
  if (select storage_location from public.quality_control where production_requirement_id=-190) is distinct from 'Shelf 3'
    or (select location_updated_by from public.quality_control where production_requirement_id=-190) is distinct from mover then
    raise exception 'QC location was not updated';
  end if;

  state := public.manufacturing_write_state();
  perform public.manufacturing_commit_with_locations(
    undo_request, actor, 'qc_undo', state->>'token',
    jsonb_build_array(jsonb_build_object('entity','requirements','id',-190,'patch',jsonb_build_object(
      'status','Ready for QC','qc_outcome','Not Inspected','qc_notes','',
      'qc_reviewed_by','','qc_reviewed_at',null))),
    jsonb_build_object('requirement_id',-190), '{"undone":true,"requirementId":-190}'
  );
  if (select count(*) from manufacturing.quality_review_retractions) <> 1
    or (select status from manufacturing.requirements where id=-190) <> 'Ready for QC'
    or (select storage_location from public.quality_control where production_requirement_id=-190) is not null then
    raise exception 'QC undo did not retain and retract history atomically';
  end if;

  state := public.manufacturing_write_state();
  rejected := false;
  begin
    perform public.manufacturing_commit(
      failed_request, actor, 'qc_review', state->>'token',
      jsonb_build_array(jsonb_build_object('entity','requirements','id',-190,'patch',jsonb_build_object('status','Complete'))),
      jsonb_build_object('requirement_id',-190,'result','invalid','notes','','reviewed_at','2026-09-05T00:02:00Z'), '{}'
    );
  exception when others then rejected := true; end;
  if not rejected then raise exception 'Invalid QC transaction was accepted'; end if;
  if (select status from manufacturing.requirements where id=-190) <> 'Ready for QC'
    or exists(select 1 from manufacturing.write_requests where request_id=failed_request) then
    raise exception 'Failed QC transaction left partial changes';
  end if;
end;
$test$;

do $test$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if has_function_privilege(role_name,
      'public.manufacturing_commit(uuid,uuid,text,text,jsonb,jsonb,jsonb)','EXECUTE') then
      raise exception 'Manufacturing commit exposed to %', role_name;
    end if;
    if has_function_privilege(role_name,
      'public.manufacturing_commit_with_locations(uuid,uuid,text,text,jsonb,jsonb,jsonb)','EXECUTE') then
      raise exception 'Manufacturing location commit exposed to %', role_name;
    end if;
  end loop;
  if not has_function_privilege('service_role',
    'public.manufacturing_commit(uuid,uuid,text,text,jsonb,jsonb,jsonb)','EXECUTE')
    or not has_function_privilege('service_role',
      'public.manufacturing_commit_with_locations(uuid,uuid,text,text,jsonb,jsonb,jsonb)','EXECUTE')
    or has_table_privilege('service_role','manufacturing.operations','UPDATE') then
    raise exception 'Service-role write boundary is incorrect';
  end if;
end;
$test$;

select true as manufacturing_write_integration_passed;
rollback;
