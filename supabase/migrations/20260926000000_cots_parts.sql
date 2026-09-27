-- COTS (purchased) parts sync as engineering-owned parts with requirements but
-- no routing. The sync marks them with parts.cots; the manufacturing app lists
-- them on Production (hidden by default) so shop staff can record a location.
-- Apply BEFORE enabling SYNC_COTS_PARTS; the RPC rejects unknown part fields.
-- Patch the deployed function without changing its owner, grants or other behavior.
begin;
alter table manufacturing.parts add column if not exists cots boolean not null default false;

do $migration$
declare
  definition text := pg_get_functiondef('public.manufacturing_apply_engineering_sync(uuid,jsonb)'::regprocedure);
  pair text[];
  original text;
  replacement text;
begin
  if position($m$'drawing_url','active','cots']$m$ in definition) > 0 then return; end if;
  foreach pair slice 1 in array array[
    [$m$'drawing_url','active']; row_key:='part_number';$m$,
     $m$'drawing_url','active','cots']; row_key:='part_number';$m$],
    [$m$onshape_url, category, drawing_url, active, last_synced_at)$m$,
     $m$onshape_url, category, drawing_url, active, last_synced_at, cots)$m$],
    [$m$category, drawing_url, active, last_synced_at from jsonb_populate_record(null::manufacturing.parts,v)$m$,
     $m$category, drawing_url, active, last_synced_at, coalesce(cots,false) from jsonb_populate_record(null::manufacturing.parts,v)$m$],
    [$m$drawing_url=case when v ? 'drawing_url' then excluded.drawing_url else existing.drawing_url end,$m$,
     $m$drawing_url=case when v ? 'drawing_url' then excluded.drawing_url else existing.drawing_url end,
        cots=case when v ? 'cots' then excluded.cots else existing.cots end,$m$]
  ] loop
    original := pair[1];
    replacement := pair[2];
    if (length(definition)-length(replace(definition,original,'')))/length(original) <> 1 then
      raise exception 'Unexpected engineering sync function; refusing to patch';
    end if;
    definition := replace(definition, original, replacement);
  end loop;
  execute definition;
end;
$migration$;
commit;
