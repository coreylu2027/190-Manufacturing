-- Apply once to installations created before 2026-09-10. This updates only
-- existing function definitions; it does not modify manufacturing data.
begin;

do $hotfix$
declare
  target record;
  definition text;
  target_count integer := 0;
begin
  for target in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'manufacturing_commit',
        'manufacturing_commit_with_locations',
        'manufacturing_commit_with_qc_quantities',
        'manufacturing_update_requirement_notes',
        'manufacturing_register_attachment'
      ])
  loop
    target_count := target_count + 1;
    definition := pg_get_functiondef(target.oid);
    if position('40001' in definition) > 0 then
      execute replace(definition, '40001', 'PT409');
    end if;
  end loop;

  if target_count <> 5 then
    raise exception 'Expected 5 manufacturing RPCs, found %', target_count;
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'manufacturing_commit',
        'manufacturing_commit_with_locations',
        'manufacturing_commit_with_qc_quantities',
        'manufacturing_update_requirement_notes',
        'manufacturing_register_attachment'
      ])
      and position('40001' in pg_get_functiondef(p.oid)) > 0
  ) then
    raise exception 'One or more manufacturing RPCs still use SQLSTATE 40001';
  end if;
end
$hotfix$;

commit;
