-- Candidate-only fixture tests. No public/Auth/QC mutations; always rolls back.
begin;
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
      values(-190,'fixture',-999);
    raise exception 'Expected missing requirement rejection';
  exception when foreign_key_violation then null; end;
  begin
    insert into manufacturing.requirements(id,production_key,location_id)
      values(-190,'fixture',-999);
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
select true as normalized_constraints_and_access_passed;
rollback;
