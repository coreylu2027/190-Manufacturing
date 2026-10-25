// Runs in isolated PostgreSQL/WASM; never contacts Supabase. Calls the shop write
// RPCs directly on the complete current schema. Each check is a PL/pgSQL block
// that raises when an expectation fails.
import test, { after } from "node:test";
import { createSchemaDatabase } from "./pglite-fixture.mts";

const { db } = await createSchemaDatabase();
after(() => db.close());
await db.exec(`
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
`);

test("a profile heartbeat does not broadcast a manufacturing change", async () => {
  await db.exec(`
    delete from realtime.messages;
    update public.profiles
    set last_seen_at = '2026-09-05T00:00:00Z'
    where id = '00000000-0000-4000-8000-000000000190';
    do $test$
    begin
      if exists(select 1 from realtime.messages) then
        raise exception 'Profile heartbeat unexpectedly broadcast a manufacturing change';
      end if;
    end;
    $test$;
  `);
});

test("a claim commits atomically, its retry is idempotent, and a stale token is rejected", async () => {
  await db.exec(`
    insert into manufacturing.requirements (
      id, production_key, required_quantity, finishing, active_in_bom,
      status, machinist, qc_outcome, qc_notes, qc_reviewed_by
    ) values (
      -190, 'write-test', 2, 'None', true, 'Ready for Manufacturing', '', 'Not Inspected', '', ''
    );
    insert into manufacturing.operations (
      id, operation_key, requirement_id, operation_number, machine,
      work_type, active_in_routing, status, machinist, claimed_quantity,
      completed_quantity, quantity_ledger
    ) values (
      -190, 'write-test|OP1', -190, 'OP1', 'Mill', 'Manufacturing', true, 'Ready', '', 0, 0, ''
    );
    insert into manufacturing.finishing (
      id, production_key, requirement_id, active, machinist
    ) values (
      -190, 'write-test', -190, true, ''
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
      exception when sqlstate 'PT409' then rejected := true; end;
      if not rejected then raise exception 'Stale concurrent edit was accepted'; end if;
    end;
    $test$;
  `);
});

test("notes, QC reviews and failures, part locations, and QC undo commit atomically with their history", async () => {
  await db.exec(`
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
      robot_location_request constant uuid := '00000000-0000-4000-8000-000000000200';
      rejected_robot_request constant uuid := '00000000-0000-4000-8000-000000000201';
      note_request constant uuid := '00000000-0000-4000-8000-000000000202';
      note_delete_request constant uuid := '00000000-0000-4000-8000-000000000203';
      qc_failure_request constant uuid := '00000000-0000-4000-8000-000000000204';
      invalid_quantity_request constant uuid := '00000000-0000-4000-8000-000000000205';
      state jsonb;
      rejected boolean := false;
    begin
      state := public.manufacturing_write_state();
      perform public.manufacturing_update_requirement_notes(
        note_request, mover, state->>'token', -190, 'Deburr the bore before inspection',
        '{"requirementId":-190,"productionNotes":"Deburr the bore before inspection"}'
      );
      if (select production_notes from manufacturing.requirements where id=-190) <> 'Deburr the bore before inspection'
        or (select count(*) from manufacturing.requirement_note_revisions
          where requirement_id=-190 and note_kind='production' and changed_by=mover
            and previous_text='' and new_text='Deburr the bore before inspection') <> 1 then
        raise exception 'Production note or its revision was not recorded';
      end if;

      update manufacturing.operations set status='Complete', claimed_quantity=0,
        completed_quantity=2, quantity_ledger='[{"userId":"00000000-0000-4000-8000-000000000190","name":"Test Admin","claimed":0,"completed":2}]'
        where id=-190;
      update manufacturing.requirements set status='Ready for QC', machinist='Test Admin (2)'
        where id=-190;

      state := public.manufacturing_write_state();
      perform public.manufacturing_commit_with_qc_quantities(
        review_request, actor, 'qc_review', state->>'token',
        jsonb_build_array(jsonb_build_object('entity','requirements','id',-190,'patch',jsonb_build_object(
          'status','Complete','qc_outcome','Passed','qc_notes','Looks good',
          'qc_reviewed_by','Test Admin','qc_reviewed_at','2026-09-05T00:01:00Z'))),
        jsonb_build_object('requirement_id',-190,'result','passed','notes','Looks good','reviewed_at','2026-09-05T00:01:00Z','location','Clarke 1'),
        '{"requirementId":-190,"result":"passed","notes":"Looks good"}'
      );
      if (select status from manufacturing.requirements where id=-190) <> 'Complete'
        or (select production_notes from manufacturing.requirements where id=-190) <> 'Deburr the bore before inspection'
        or (select qc_notes from manufacturing.requirements where id=-190) <> 'Looks good'
        or (select count(*) from public.quality_control where production_requirement_id=-190 and result='passed' and storage_location='Clarke 1') <> 1 then
        raise exception 'QC review was not committed atomically';
      end if;
      if (select count(*) from manufacturing.requirement_note_revisions
          where requirement_id=-190 and note_kind='inspection' and changed_by=actor
            and previous_text='' and new_text='Looks good') <> 1 then
        raise exception 'Inspection note revision was not recorded';
      end if;

      state := public.manufacturing_write_state();
      perform public.manufacturing_update_requirement_notes(
        note_delete_request, actor, state->>'token', -190, '',
        '{"requirementId":-190,"productionNotes":""}'
      );
      if (select production_notes from manufacturing.requirements where id=-190) <> ''
        or (select qc_notes from manufacturing.requirements where id=-190) <> 'Looks good'
        or (select count(*) from manufacturing.requirement_note_revisions
          where requirement_id=-190 and note_kind='production') <> 2 then
        raise exception 'QC reviewer could not delete only the production note';
      end if;

      state := public.manufacturing_write_state();
      begin
        perform public.manufacturing_commit_with_locations(
          rejected_location_request, pending_actor, 'part_location', state->>'token', '[]',
          jsonb_build_object('requirement_id',-190,'location','Shelf 3','location_updated_at','2026-09-05T00:01:20Z'), '{}'
        );
      exception when insufficient_privilege then rejected := true; end;
      if not rejected then raise exception 'Unapproved user changed a part location'; end if;

      state := public.manufacturing_write_state();
      perform public.manufacturing_commit_with_locations(
        robot_location_request, mover, 'part_location', state->>'token', '[]',
        jsonb_build_object('requirement_id',-190,'location','On Robot','location_updated_at','2026-09-05T00:01:25Z'),
        '{"storageLocation":"On Robot"}'
      );
      if (select part_location from manufacturing.requirements where id=-190) is distinct from 'On Robot' then
        raise exception 'Eligible part could not be moved onto the robot';
      end if;

      state := public.manufacturing_write_state();
      perform public.manufacturing_commit_with_locations(
        location_request, mover, 'part_location', state->>'token', '[]',
        jsonb_build_object('requirement_id',-190,'location','Shelf 3','location_updated_at','2026-09-05T00:01:30Z'),
        '{"storageLocation":"Shelf 3","locationUpdatedBy":"Test Machinist","locationUpdatedAt":"2026-09-05T00:01:30Z"}'
      );
      if (select part_location from manufacturing.requirements where id=-190) is distinct from 'Shelf 3'
        or (select location_updated_by from manufacturing.requirements where id=-190) is distinct from 'Test Machinist' then
        raise exception 'Part location was not updated';
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
        or (select storage_location from public.quality_control where production_requirement_id=-190) is not null
        or (select part_location from manufacturing.requirements where id=-190) is distinct from 'Shelf 3' then
        raise exception 'QC undo did not retain and retract history atomically';
      end if;

      state := public.manufacturing_write_state();
      rejected := false;
      begin
        perform public.manufacturing_commit_with_locations(
          rejected_robot_request, mover, 'part_location', state->>'token', '[]',
          jsonb_build_object('requirement_id',-190,'location','On Robot','location_updated_at','2026-09-05T00:01:40Z'), '{}'
        );
      exception when sqlstate 'PT409' then rejected := true; end;
      if not rejected then raise exception 'Part moved onto the robot without an effective QC pass'; end if;

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

      state := public.manufacturing_write_state();
      perform public.manufacturing_commit_with_qc_quantities(
        qc_failure_request, actor, 'qc_review', state->>'token',
        jsonb_build_array(
          jsonb_build_object('entity','operations','id',-190,'patch',jsonb_build_object(
            'status','Ready','machinist','Test Admin (1)','claimed_quantity',0,
            'completed_quantity',1,'quantity_ledger','[{"userId":"00000000-0000-4000-8000-000000000190","name":"Test Admin","claimed":0,"completed":1}]',
            'completed_at',null)),
          jsonb_build_object('entity','requirements','id',-190,'patch',jsonb_build_object(
            'status','Ready for Manufacturing','qc_outcome','Failed','qc_notes','Bore is oversized',
            'qc_reviewed_by','Test Admin','qc_reviewed_at','2026-09-05T00:03:00Z'))
        ),
        jsonb_build_object('requirement_id',-190,'result','failed','notes','Bore is oversized',
          'rejected_quantity',1,'reviewed_at','2026-09-05T00:03:00Z','location',null),
        '{"requirementId":-190,"result":"failed","rejectedQuantity":1}'
      );
      if (select status from manufacturing.operations where id=-190) <> 'Ready'
        or (select claimed_quantity from manufacturing.operations where id=-190) <> 0
        or (select completed_quantity from manufacturing.operations where id=-190) <> 1
        or (select status from manufacturing.requirements where id=-190) <> 'Ready for Manufacturing'
        or (select count(*) from public.quality_control
          where production_requirement_id=-190 and result='failed'
            and rejected_quantity=1 and notes='Bore is oversized') <> 1
        or (select count(*) from manufacturing.write_history where request_id=qc_failure_request) <> 2 then
        raise exception 'Rejected QC quantity was not committed atomically';
      end if;

      state := public.manufacturing_write_state();
      rejected := false;
      begin
        perform public.manufacturing_commit_with_qc_quantities(
          invalid_quantity_request, actor, 'qc_review', state->>'token',
          jsonb_build_array(jsonb_build_object('entity','requirements','id',-190,'patch',
            jsonb_build_object('status','Complete'))),
          jsonb_build_object('requirement_id',-190,'result','failed','notes','Bad bore',
            'rejected_quantity',3,'reviewed_at','2026-09-05T00:04:00Z','location',null), '{}'
        );
      exception when others then rejected := true; end;
      if not rejected then raise exception 'Out-of-range rejected quantity was accepted'; end if;
      if (select status from manufacturing.requirements where id=-190) <> 'Ready for Manufacturing'
        or exists(select 1 from manufacturing.write_requests where request_id=invalid_quantity_request) then
        raise exception 'Invalid rejected quantity left partial changes';
      end if;
    end;
    $test$;
  `);
});

test("write RPCs are server-only and every manufacturing table broadcasts a private cache version", async () => {
  await db.exec(`
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
        if has_function_privilege(role_name,
          'public.manufacturing_commit_with_qc_quantities(uuid,uuid,text,text,jsonb,jsonb,jsonb)','EXECUTE') then
          raise exception 'Manufacturing QC quantity commit exposed to %', role_name;
        end if;
        if has_function_privilege(role_name,
          'public.manufacturing_update_requirement_notes(uuid,uuid,text,bigint,text,jsonb)','EXECUTE') then
          raise exception 'Manufacturing note update exposed to %', role_name;
        end if;
      end loop;
      if not has_function_privilege('service_role',
        'public.manufacturing_commit(uuid,uuid,text,text,jsonb,jsonb,jsonb)','EXECUTE')
        or not has_function_privilege('service_role',
          'public.manufacturing_commit_with_locations(uuid,uuid,text,text,jsonb,jsonb,jsonb)','EXECUTE')
        or not has_function_privilege('service_role',
          'public.manufacturing_commit_with_qc_quantities(uuid,uuid,text,text,jsonb,jsonb,jsonb)','EXECUTE')
        or not has_function_privilege('service_role',
          'public.manufacturing_update_requirement_notes(uuid,uuid,text,bigint,text,jsonb)','EXECUTE')
        or not has_function_privilege('service_role',
          'public.manufacturing_data_version()','EXECUTE')
        or has_table_privilege('service_role','manufacturing.operations','UPDATE') then
        raise exception 'Service-role write boundary is incorrect';
      end if;
      if has_function_privilege('anon', 'public.manufacturing_data_version()','EXECUTE')
        or has_function_privilege('authenticated', 'public.manufacturing_data_version()','EXECUTE')
        or has_table_privilege('service_role','manufacturing.data_version','SELECT') then
        raise exception 'Manufacturing cache version boundary is incorrect';
      end if;
      if public.manufacturing_data_version() !~ '^[0-9]+$' then
        raise exception 'Manufacturing data version is invalid';
      end if;
      if not exists (
        select 1 from realtime.messages
        where topic = 'manufacturing:changes'
          and event = 'changed'
          and payload->>'version' = public.manufacturing_data_version()
          and private
      ) then
        raise exception 'Manufacturing changes did not emit a private version broadcast';
      end if;
      -- Exactly one statement-level broadcast trigger per listed table: a
      -- missing one loses invalidations, an extra one duplicates them.
      if (
        select array_agg(tgrelid order by tgrelid)
        from pg_trigger
        where tgname in ('broadcast_manufacturing_change', 'broadcast_manufacturing_profile_change')
          and not tgisinternal
          and (tgtype & 1) = 0
      ) is distinct from (
        select array_agg(relation::oid order by relation::oid) from unnest(array[
          'manufacturing.assemblies', 'manufacturing.parts', 'manufacturing.requirements', 'manufacturing.operations',
          'manufacturing.operation_allocations', 'manufacturing.finishing', 'manufacturing.attachments',
          'manufacturing.attachment_overrides', 'manufacturing.engineering_overrides',
          'manufacturing.quality_review_retractions', 'public.quality_control', 'public.profiles'
        ]::regclass[]) as expected(relation)
      ) then
        raise exception 'Manufacturing Realtime trigger coverage is incorrect';
      end if;
    end;
    $test$;
  `);
});

test("claims and completions can set the part location in the same transaction", async () => {
  await db.exec(`
    insert into auth.users(id,email,raw_user_meta_data) values
      ('00000000-0000-4000-8000-000000000301','printer-test@example.test','{}'),
      ('00000000-0000-4000-8000-000000000302','pending-printer-test@example.test','{}');
    update public.profiles set display_name='Printer Tester', role='machinist', approved=true
    where id='00000000-0000-4000-8000-000000000301';
    insert into manufacturing.requirements(id,production_key,required_quantity,active_in_bom,status,qc_outcome)
    values(-301,'printer-test',2,true,'Ready for Manufacturing','Not Inspected');
    insert into manufacturing.operations(id,operation_key,requirement_id,operation_number,machine,
      work_type,active_in_routing,status,claimed_quantity,completed_quantity,quantity_ledger)
    values(-301,'printer-test|OP1',-301,'OP1','Bambu 3D Printer','Manufacturing',true,'Ready',0,0,'[]');
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
  `);
});

test("read and file RPCs are server-only, allowlisted, and bounded", async () => {
  await db.exec(`
    do $test$
    declare role_name text;
    begin
      foreach role_name in array array['anon','authenticated'] loop
        if has_schema_privilege(role_name,'manufacturing','USAGE')
          or has_function_privilege(role_name,'public.manufacturing_read_entity(text,integer,integer)','EXECUTE')
        then raise exception 'Manufacturing data exposed to %', role_name; end if;
      end loop;
      if not has_function_privilege('service_role','public.manufacturing_read_entity(text,integer,integer)','EXECUTE')
      then raise exception 'Server reader lacks RPC access'; end if;
      begin
        insert into manufacturing.operations(id,operation_key,requirement_id)
          values(-990,'fixture',-999);
        raise exception 'Expected missing requirement rejection';
      exception when foreign_key_violation then null; end;
      begin
        insert into manufacturing.requirements(id,production_key,location_id)
          values(-990,'fixture',-999);
        raise exception 'Expected missing location rejection';
      exception when foreign_key_violation then null; end;
      begin
        perform public.manufacturing_read_entity('quality_control',0,500);
        raise exception using errcode='XX001',message='Reader allowed an unlisted table';
      exception when raise_exception then null; end;
      begin
        perform public.manufacturing_read_entity('operations',0,501);
        raise exception using errcode='XX001',message='Reader allowed an unbounded page';
      exception when raise_exception then null; end;
    end; $test$;

    insert into manufacturing.parts(id, part_number) values (-191, 'P-TEST');
    insert into manufacturing.requirements(id, production_key, part_id) values (-191, 'attachment-test', -191);
    insert into manufacturing.attachments(part_id, kind, position, source_field_id, source_url, source_metadata,
      original_name, content_type, byte_size, sha256, storage_bucket, storage_path, verified_at)
    values (-191, 'drawing-pdf', 0, 0, 'https://onshape.test/attachment-test', '{}', 'drawing.pdf', 'application/pdf', 4,
      repeat('a', 64), 'manufacturing-files', 'sha256/aa/' || repeat('a', 64) || '.pdf', now());

    do $test$
    declare
      role_name text;
      file jsonb := public.manufacturing_file_for_requirement(-191, 'drawing-pdf');
    begin
      -- lib/manufacturing/files.ts validates exactly these resolver keys.
      if file->>'path' is distinct from 'sha256/aa/' || repeat('a', 64) || '.pdf'
        or file->>'name' is distinct from 'drawing.pdf' or (file->>'byte_size')::bigint is distinct from 4
        or file->>'bucket' is distinct from 'manufacturing-files' or file->>'content_type' is distinct from 'application/pdf'
        or file->>'sha256' is distinct from repeat('a', 64) then
        raise exception 'Requirement attachment lookup failed: %', file;
      end if;
      foreach role_name in array array['anon','authenticated'] loop
        if has_function_privilege(role_name, 'public.manufacturing_file_for_requirement(bigint,text)', 'EXECUTE')
          or has_function_privilege(role_name, 'public.manufacturing_attachment_manifest()', 'EXECUTE') then
          raise exception 'Attachment metadata exposed to %', role_name;
        end if;
      end loop;
      if not has_function_privilege('service_role', 'public.manufacturing_file_for_requirement(bigint,text)', 'EXECUTE')
        or has_table_privilege('service_role', 'manufacturing.attachments', 'SELECT') then
        raise exception 'Attachment service-role boundary is incorrect';
      end if;
    end;
    $test$;
  `);
});
