begin;

do $migration$
declare
  definition text := pg_get_functiondef('public.manufacturing_apply_engineering_sync(uuid,jsonb)'::regprocedure);
  original text := 'and o.active_in_routing is distinct from false';
  replacement text := 'and o.work_type = ''Manufacturing'' and o.active_in_routing is distinct from false';
begin
  if position(replacement in definition) > 0 then
    return;
  end if;
  if (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 then
    raise exception 'Unexpected engineering sync function; refusing to patch';
  end if;
  execute replace(definition, original, replacement);
end;
$migration$;

commit;
