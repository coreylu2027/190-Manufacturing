import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { ENTITIES, normalizeRow, type RawRow } from "../../lib/manufacturing/model.ts";
import { digest, sqlLiteral, validateTables } from "./core.mts";
const file = resolve(process.argv[2] ?? "");
const rel = relative(resolve("migration-artifacts"), file);
if (process.argv.length !== 3 || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Supply a private staged snapshot.json");
const snapshot = JSON.parse(await readFile(file, "utf8"));
const expected = (await readFile(resolve(dirname(file), "snapshot.sha256"), "utf8")).trim();
if (digest(snapshot) !== expected || snapshot.project_ref !== (await readFile("supabase/.temp/project-ref","utf8")).trim()) throw new Error("Snapshot integrity/project mismatch");
validateTables(snapshot.tables, [1119643,1126322]);
const normalized = Object.fromEntries(ENTITIES.map(entity => [entity.name,
  snapshot.tables.find((table: {id: number}) => table.id === entity.tableId).rows.map((row: RawRow) => ({
    ...normalizeRow(entity, row), source_snapshot_id: snapshot.id
  }))]));
const sid = "'" + snapshot.id + "'::uuid";
let sql = `begin;
set local statement_timeout = '120s';
select pg_advisory_xact_lock(190,515012);
do $guard$ begin
  if not exists (select 1 from frc190_baserow_stage.snapshots where id=${sid} and document_sha256='${expected}')
  then raise exception 'Verified staged snapshot missing or different'; end if;
end; $guard$;
`;
for (const entity of ENTITIES) {
  const cols = ["id","baserow_id","source_snapshot_id","source_row",...entity.columns.map(c=>c[0])];
  const list = cols.join(",");
  sql += `
do $entity$
declare expected jsonb := ${sqlLiteral(normalized[entity.name])};
begin
  -- Compare typed values before any insert. Existing claims/progress are never updated.
  if exists (select 1 from jsonb_populate_recordset(null::manufacturing.${entity.name},expected) e
    join manufacturing.${entity.name} t on t.id=e.id
    where row(${cols.map(c=>"t."+c).join(",")}) is distinct from row(${cols.map(c=>"e."+c).join(",")}))
  then raise exception 'Existing ${entity.name} differs; no production state overwritten'; end if;
  insert into manufacturing.${entity.name}(${list})
    select ${list} from jsonb_populate_recordset(null::manufacturing.${entity.name},expected)
    on conflict (id) do nothing;
  if exists ((select ${list} from jsonb_populate_recordset(null::manufacturing.${entity.name},expected)
    except select ${list} from manufacturing.${entity.name}))
  then raise exception 'Normalized ${entity.name} verification failed'; end if;
end; $entity$;
-- Never move a sequence backwards during retry or after new production rows.
select setval(pg_get_serial_sequence('manufacturing.${entity.name}','id'),
  greatest((select coalesce(max(id),0)+1 from manufacturing.${entity.name}),
           (select last_value from manufacturing.${entity.name}_id_seq)), false);
`;
}
sql += `
-- Retain ledger text verbatim and also index every allocation relationally.
insert into manufacturing.operation_allocations(operation_id, ordinal, user_id, display_name, claimed, completed, source_allocation)
select o.id, a.ordinality::integer, a.value->>'userId', a.value->>'name',
  (a.value->>'claimed')::numeric, (a.value->>'completed')::numeric, a.value
from manufacturing.operations o cross join lateral
  jsonb_array_elements(coalesce(nullif(o.quantity_ledger,''),'[]')::jsonb) with ordinality a
where o.source_snapshot_id=${sid}
on conflict do nothing;
do $allocations$ begin
  if exists (
    select 1 from manufacturing.operations o cross join lateral
      jsonb_array_elements(coalesce(nullif(o.quantity_ledger,''),'[]')::jsonb) with ordinality a
      left join manufacturing.operation_allocations stored on stored.operation_id=o.id and stored.ordinal=a.ordinality
    where o.source_snapshot_id=${sid} and (stored.source_allocation is distinct from a.value
      or stored.user_id is distinct from a.value->>'userId'
      or stored.display_name is distinct from a.value->>'name'
      or stored.claimed is distinct from (a.value->>'claimed')::numeric
      or stored.completed is distinct from (a.value->>'completed')::numeric)
  ) then raise exception 'Allocation preservation check failed'; end if;
end; $allocations$;
insert into manufacturing.imports(snapshot_id,counts) values (${sid},${sqlLiteral(Object.fromEntries(Object.entries(normalized).map(([name, rows]) => [name, (rows as unknown[]).length])))}) on conflict do nothing;
select true as verified, (select count(*) from manufacturing.parts) as parts,
  (select count(*) from manufacturing.requirements) as requirements,
  (select count(*) from manufacturing.operations) as operations,
  (select count(*) from manufacturing.finishing) as finishing,
  (select count(*) from manufacturing.operation_allocations) as allocations,
  (select count(*) from manufacturing.locations) as locations;
commit;
`;
await writeFile(resolve(dirname(file),"import-normalized.sql"),sql,{flag:"wx"});
console.log(JSON.stringify({ prepared: true, counts: Object.fromEntries(Object.entries(normalized).map(([k,v])=>[k,(v as unknown[]).length])), remote_writes: 0 }));
