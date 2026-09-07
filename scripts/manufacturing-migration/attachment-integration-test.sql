\set ON_ERROR_STOP on

begin;

insert into manufacturing.parts(id, source_row, part_number)
values (-191, '{"id":-191}', 'P-TEST');
insert into manufacturing.requirements(id, source_row, production_key, part_id)
values (-191, '{"id":-191}', 'attachment-test', -191);

do $test$
declare
  first_id bigint;
  retry_id bigint;
  file jsonb;
  rejected boolean := false;
begin
  first_id := public.manufacturing_register_attachment(
    -191, 'drawing-pdf', 0, 10514965, 'https://files.baserow.io/example.pdf',
    '{"name":"source.pdf","size":4}', 'drawing.pdf', 'application/pdf', 4,
    repeat('a', 64), 'manufacturing-files', 'sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf',
    '2026-09-05T00:00:00Z'
  );
  retry_id := public.manufacturing_register_attachment(
    -191, 'drawing-pdf', 0, 10514965, 'https://files.baserow.io/example.pdf',
    '{"name":"source.pdf","size":4}', 'drawing.pdf', 'application/pdf', 4,
    repeat('a', 64), 'manufacturing-files', 'sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf',
    '2026-09-05T00:01:00Z'
  );
  if first_id <> retry_id or (select count(*) from manufacturing.attachments) <> 1 then
    raise exception 'Attachment registration is not idempotent';
  end if;

  file := public.manufacturing_file_for_requirement(-191, 'drawing-pdf');
  if file->>'path' <> 'sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf'
    or file->>'name' <> 'drawing.pdf' or (file->>'byte_size')::bigint <> 4 then
    raise exception 'Requirement attachment lookup failed';
  end if;

  begin
    perform public.manufacturing_register_attachment(
      -191, 'drawing-pdf', 0, 10514965, 'https://files.baserow.io/example.pdf',
      '{"name":"changed.pdf","size":4}', 'drawing.pdf', 'application/pdf', 4,
      repeat('a', 64), 'manufacturing-files', 'sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf',
      '2026-09-05T00:02:00Z'
    );
  exception when serialization_failure then rejected := true; end;
  if not rejected then raise exception 'Conflicting attachment registration was accepted'; end if;
end;
$test$;

do $test$
declare role_name text;
begin
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

select true as manufacturing_attachment_integration_passed;
rollback;
