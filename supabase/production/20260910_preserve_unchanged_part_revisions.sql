-- Requirement work follows the required part revision, not the revision of the
-- parent manufacturing-root assembly. On the first v2 sync, re-key a single
-- active legacy requirement in place so its shop state and dependent row IDs
-- survive. Ambiguous matches fail the transaction rather than guessing.
begin;
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.manufacturing_apply_engineering_sync(uuid,jsonb)'::regprocedure
  );
  marker text := $marker$    for v in select value from jsonb_array_elements(p_payload->'requirements') loop$marker$;
  patch text := $patch$    -- Revision-stable requirement identity (sync schema v2).
    for v in select value from jsonb_array_elements(p_payload->'requirements') loop
      if exists(
          select 1 from jsonb_array_elements(p_payload->'assemblies') a
          where a->>'assembly_number'=v->>'source_root'
            and a->>'sync_schema_version'='supabase-engineering-v2'
        ) and v->>'production_key' is distinct from
          concat(
            coalesce(v->>'source_root',''), '|',
            coalesce(v->>'required_part_revision',''), '|',
            coalesce(v->>'assembly_number',''), '|',
            coalesce(v->>'part_number',''), '|',
            coalesce(v->>'configuration','default'), '|v2'
          ) then
        raise exception 'Invalid revision-stable requirement identity';
      end if;

      if not exists(
        select 1 from manufacturing.requirements r
        where r.production_key=v->>'production_key'
      ) then
        select count(*), min(r.id)
        into operation_matches, requirement_id_value
        from manufacturing.requirements r
        join manufacturing.parts p on p.id=r.part_id
        left join manufacturing.assemblies a on a.id=r.assembly_id
        where coalesce(
                nullif(r.source_root,''),
                case when cardinality(string_to_array(r.production_key,'|'))>=5
                  then split_part(r.production_key,'|',1) end
              )=v->>'source_root'
          and coalesce(a.assembly_number,'')=coalesce(v->>'assembly_number','')
          and p.part_number=v->>'part_number'
          and coalesce(r.configuration,'default')=coalesce(v->>'configuration','default')
          and coalesce(nullif(r.required_part_revision,''),p.revision,'')=
            coalesce(v->>'required_part_revision','')
          and r.active_in_bom is distinct from false;

        if operation_matches>1 then
          raise exception 'Ambiguous legacy requirement identity for %', v->>'production_key';
        end if;
        if operation_matches=1 then
          update manufacturing.operations o
          set operation_key=(v->>'production_key') || '|' || o.operation_number
          where o.requirement_id=requirement_id_value
            and o.work_type='Manufacturing'
            and o.operation_number in ('OP1','OP2','OP3','OP4');

          update manufacturing.finishing f
          set production_key=v->>'production_key'
          where f.requirement_id=requirement_id_value;

          update manufacturing.requirements r
          set production_key=v->>'production_key'
          where r.id=requirement_id_value;
        end if;
      end if;
    end loop;

$patch$;
begin
  if position('Revision-stable requirement identity (sync schema v2)' in definition)>0 then
    return;
  end if;
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then
    raise exception 'Unexpected engineering sync function; refusing to patch';
  end if;
  execute replace(definition,marker,patch || marker);
end;
$migration$;
commit;
