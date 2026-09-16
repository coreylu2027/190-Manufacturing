\set ON_ERROR_STOP on
-- Run after write-test-bootstrap.sql in an isolated database only.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000301','printer-test@example.test','{}'),
  ('00000000-0000-4000-8000-000000000302','pending-printer-test@example.test','{}');
update public.profiles set display_name='Printer Tester', role='machinist', approved=true
where id='00000000-0000-4000-8000-000000000301';
insert into manufacturing.requirements(id,source_row,production_key,required_quantity,active_in_bom,status,qc_outcome)
values(-301,'{}','printer-test',2,true,'Ready for Manufacturing','Not Inspected');
insert into manufacturing.operations(id,source_row,operation_key,requirement_id,operation_number,machine,
  work_type,active_in_routing,status,claimed_quantity,completed_quantity,quantity_ledger)
values(-301,'{}','printer-test|OP1',-301,'OP1','Bambu 3D Printer','Manufacturing',true,'Ready',0,0,'[]');
update manufacturing.write_control set enabled=true;

do $test$
declare
  actor constant uuid := '00000000-0000-4000-8000-000000000301';
  request uuid := gen_random_uuid();
  failed_request uuid := gen_random_uuid();
  stamp text := clock_timestamp()::text;
  token text;
  changes jsonb;
  result jsonb;
  completion jsonb;
  final_result jsonb;
  rejected boolean;
  printer text;
begin
  foreach printer in array array['Bambu X1C #1','Bambu X1C #2','Bambu X1C #3','Bambu H2D','Bambu X1C Pit'] loop
    update manufacturing.requirements set part_location=printer where id=-301;
    if position(printer in pg_get_constraintdef((select oid from pg_constraint
      where conrelid='public.quality_control'::regclass and conname='quality_control_storage_location_check'))) = 0 then
      raise exception 'QC constraint is missing printer %',printer;
    end if;
  end loop;
  update manufacturing.requirements set part_location=null where id=-301;
  token := public.manufacturing_write_state()->>'token';
  changes := jsonb_build_array(
    jsonb_build_object('entity','operations','id',-301,'patch',jsonb_build_object(
      'status','In Progress','machinist','Printer Tester','claimed_quantity',2,'completed_quantity',0,
      'quantity_ledger','[{"userId":"00000000-0000-4000-8000-000000000301","name":"Printer Tester","claimed":2,"completed":0}]')),
    jsonb_build_object('entity','requirements','id',-301,'patch',jsonb_build_object('status','On Machine')));
  result := jsonb_build_object('id',-301,'status','In Progress','storageLocation','Bambu X1C #1',
    'locationUpdatedBy','Printer Tester','locationUpdatedAt',stamp,'notificationContext',jsonb_build_object('requirementId',-301));

  rejected := false;
  begin
    perform public.manufacturing_commit_with_operation_location(gen_random_uuid(),
      '00000000-0000-4000-8000-000000000302','claim',token,changes,null,result);
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'Unapproved actor accepted'; end if;

  perform public.manufacturing_commit_with_operation_location(request,actor,'claim',token,changes,null,result);
  if (select part_location from manufacturing.requirements where id=-301) <> 'Bambu X1C #1'
    or (select claimed_quantity from manufacturing.operations where id=-301) <> 2
    or (select count(*) from manufacturing.write_history where request_id=request) <> 3 then
    raise exception 'Claim and location did not commit together with audit';
  end if;

  perform public.manufacturing_commit_with_locations(gen_random_uuid(),actor,'part_location',
    public.manufacturing_write_state()->>'token','[]',jsonb_build_object('requirement_id',-301,
    'location','Shelf 1','location_updated_at',stamp),'{}');
  perform public.manufacturing_commit_with_operation_location(request,actor,'claim',token,changes,null,result);
  if (select part_location from manufacturing.requirements where id=-301) <> 'Shelf 1' then
    raise exception 'Retry moved the part back to an old location';
  end if;

  rejected := false;
  begin
    perform public.manufacturing_commit_with_operation_location(request,actor,'claim',token,changes,null,
      result || '{"storageLocation":"Bambu H2D"}');
  exception when sqlstate 'PT409' then rejected := true;
  end;
  if not rejected then raise exception 'Changed retry payload accepted'; end if;

  rejected := false;
  begin
    perform public.manufacturing_commit_with_operation_location(gen_random_uuid(),actor,'claim',token,changes,null,result);
  exception when sqlstate 'PT409' or serialization_failure then rejected := true;
  end;
  if not rejected then raise exception 'Stale snapshot accepted'; end if;

  completion := jsonb_build_array(
    jsonb_build_object('entity','operations','id',-301,'patch',jsonb_build_object(
      'status','Complete','claimed_quantity',0,'completed_quantity',2,
      'quantity_ledger','[{"userId":"00000000-0000-4000-8000-000000000301","name":"Printer Tester","claimed":0,"completed":2}]')),
    jsonb_build_object('entity','requirements','id',-301,'patch',jsonb_build_object('status','Ready for QC')));
  final_result := result || '{"status":"Complete","storageLocation":"Unknown drawer"}';
  token := public.manufacturing_write_state()->>'token';
  rejected := false;
  begin
    perform public.manufacturing_commit_with_operation_location(failed_request,actor,'complete',token,completion,null,final_result);
  exception when check_violation then rejected := true;
  end;
  if not rejected or (select completed_quantity from manufacturing.operations where id=-301) <> 0
    or exists(select 1 from manufacturing.write_requests where request_id=failed_request)
    or (select part_location from manufacturing.requirements where id=-301) <> 'Shelf 1' then
    raise exception 'Invalid location failed to roll back the entire completion';
  end if;

  rejected := false;
  begin
    perform public.manufacturing_commit_with_operation_location(gen_random_uuid(),actor,'complete',token,completion,null,
      final_result || '{"storageLocation":"On Robot"}');
  exception when sqlstate 'PT409' then rejected := true;
  end;
  if not rejected then raise exception 'On Robot bypass accepted'; end if;

  perform public.manufacturing_commit_with_operation_location(gen_random_uuid(),actor,'complete',token,completion,null,
    final_result || '{"storageLocation":"Clarke 1"}');
  if (select part_location from manufacturing.requirements where id=-301) <> 'Clarke 1'
    or (select status from manufacturing.requirements where id=-301) <> 'Ready for QC'
    or (select completed_quantity from manufacturing.operations where id=-301) <> 2
    or exists(select 1 from public.quality_control where production_requirement_id=-301) then
    raise exception 'Completion did not preserve the QC workflow';
  end if;

  if has_function_privilege('anon','public.manufacturing_commit_with_operation_location(uuid,uuid,text,text,jsonb,jsonb,jsonb)','execute')
    or has_function_privilege('authenticated','public.manufacturing_commit_with_operation_location(uuid,uuid,text,text,jsonb,jsonb,jsonb)','execute')
    or not has_function_privilege('service_role','public.manufacturing_commit_with_operation_location(uuid,uuid,text,text,jsonb,jsonb,jsonb)','execute') then
    raise exception 'Operation location RPC grants are incorrect';
  end if;
end;
$test$;
rollback;
