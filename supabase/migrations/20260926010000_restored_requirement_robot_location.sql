-- Restoring a requirement from obsolete does not reactivate its BOM row or
-- routing, so the On Robot guard found no active inspected operations and
-- rejected every restored historical requirement. When a requirement has no
-- active routing, judge the QC pass against its deactivated routing instead,
-- matching the app projection. Obsolete requirements stay blocked by
-- manufacturing.guard_obsolete_work.
-- Patch the deployed function without changing its owner, grants or other behavior.
begin;

do $migration$
declare
  definition text := pg_get_functiondef('public.manufacturing_commit_with_locations(uuid,uuid,text,text,jsonb,jsonb,jsonb)'::regprocedure);
  original text := $m$where o.requirement_id = target_requirement_id and o.active_in_routing$m$;
  replacement text := $m$where o.requirement_id = target_requirement_id and (o.active_in_routing or not exists(
          select 1 from manufacturing.operations active_o
          where active_o.requirement_id = target_requirement_id and active_o.active_in_routing))$m$;
begin
  if position('active_o.active_in_routing' in definition) > 0 then return; end if;
  if (length(definition)-length(replace(definition,original,'')))/length(original) <> 2 then
    raise exception 'Unexpected part location function; refusing to patch';
  end if;
  execute replace(definition, original, replacement);
end;
$migration$;
commit;
