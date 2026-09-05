-- Run only after the isolated staging schema exists. All fixtures roll back.
begin;
insert into frc190_baserow_stage.snapshots(id, document_sha256, document)
values ('00000000-0000-4000-8000-000000000190', repeat('0',64),
  '{"id":"00000000-0000-4000-8000-000000000190","version":1}');
insert into frc190_baserow_stage.source_tables(snapshot_id, table_id, fields)
values ('00000000-0000-4000-8000-000000000190', 1169282, '[]'),
       ('00000000-0000-4000-8000-000000000190', 1119642, '[]');
insert into frc190_baserow_stage.source_rows(snapshot_id, table_id, row_id, payload)
values ('00000000-0000-4000-8000-000000000190', 1169282, 1, '{"id":1}'),
       ('00000000-0000-4000-8000-000000000190', 1119642, 20, '{"id":20}');
do $$
declare denied boolean := false; role_name text;
begin
  begin
    insert into frc190_baserow_stage.source_links(snapshot_id, source_table_id, source_row_id, field_id, position, target_table_id, target_row_id, external)
    values ('00000000-0000-4000-8000-000000000190', 1169282, 1, 100, 0, 1119642, 999, false);
    raise exception 'Expected dangling-link rejection';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into frc190_baserow_stage.source_links(snapshot_id, source_table_id, source_row_id, field_id, position, target_table_id, target_row_id, external)
    values ('00000000-0000-4000-8000-000000000190', 1169282, 1, 100, 0, 1119642, 999, true);
    raise exception 'Expected unauthorized exclusion rejection';
  exception when check_violation then null;
  end;
  begin
    insert into frc190_baserow_stage.qc_references(snapshot_id, ordinal, requirement_id, provenance)
    values ('00000000-0000-4000-8000-000000000190', 1, 999, '{}');
    raise exception 'Expected unresolved QC rejection';
  exception when foreign_key_violation then null;
  end;
  begin
    update frc190_baserow_stage.source_rows set payload = '{"id":1,"changed":true}'
      where snapshot_id = '00000000-0000-4000-8000-000000000190' and table_id = 1169282;
  exception when raise_exception then
    if sqlerrm not like 'Staged snapshots are immutable%' then raise; end if;
    denied := true;
  end;
  if not denied then raise exception 'Expected immutable snapshot rejection'; end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if has_schema_privilege(role_name, 'frc190_baserow_stage', 'USAGE')
      or has_table_privilege(role_name, 'frc190_baserow_stage.snapshots', 'SELECT') then
      raise exception 'Unexpected staging access for %', role_name;
    end if;
  end loop;
end;
$$;
insert into frc190_baserow_stage.source_links(snapshot_id, source_table_id, source_row_id, field_id, position, target_table_id, target_row_id, external)
values ('00000000-0000-4000-8000-000000000190', 1169282, 1, 100, 0, 1119642, 20, false),
       ('00000000-0000-4000-8000-000000000190', 1169282, 1, 101, 0, 1119643, 7, true);
select true as migration_constraints_passed;
rollback;
