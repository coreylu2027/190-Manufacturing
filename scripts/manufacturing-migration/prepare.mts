import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { digest, canonical, sqlLiteral, validateTables, validateQc, type SourceTable } from "./core.mts";

const input = process.argv[2];
const verifyOnly = process.argv[3] === "--verify-only";
if (!input || (process.argv.length !== 3 && !(process.argv.length === 4 && verifyOnly))) throw new Error("Usage: prepare.mts migration-artifacts/<capture>/snapshot.json [--verify-only]");
const file = resolve(input);
const relativeFile = relative(resolve("migration-artifacts"), file);
if (relativeFile.startsWith("..") || isAbsolute(relativeFile)) throw new Error("Use a private snapshot under migration-artifacts");
const document = JSON.parse(await readFile(file, "utf8"));
const expectedDigest = (await readFile(resolve(dirname(file), "snapshot.sha256"), "utf8")).trim();
if (digest(document) !== expectedDigest) throw new Error("Snapshot checksum mismatch");
if (document.version !== 1 || !/^[a-f0-9-]{36}$/.test(document.id)) throw new Error("Unsupported snapshot");
const projectRef = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
if (document.project_ref !== projectRef) throw new Error("Snapshot belongs to another Supabase project");
const tables = document.tables as SourceTable[];
if (canonical(document.excluded_table_ids) !== canonical([1119643, 1126322])) throw new Error("Unexpected exclusions");
if (tables.some((t) => document.excluded_table_ids.includes(t.id))) throw new Error("Excluded table present");
if (digest(tables) !== document.source_digest || digest(document.existing_supabase) !== document.baseline_digest) throw new Error("Source/baseline digest mismatch");
if (canonical(validateTables(tables, document.excluded_table_ids)) !== canonical(document.links)) throw new Error("Relationship manifest differs");
if (canonical(validateQc(tables, document.existing_supabase.tables.quality_control, 1169282, 1119642)) !== canonical(document.qc_references)) throw new Error("QC mapping differs");

const snapshotId = `'${document.id}'::uuid`;
// EXCEPT in both directions checks values, not merely row counts. Existing
// public records must match the captured baseline inside the import transaction.
function baselineChecks(): string {
  return Object.keys(document.existing_supabase.tables).map((table) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Invalid baseline table");
    return `if exists (
      (select to_jsonb(t) from public."${table}" t except select value from jsonb_array_elements(doc->'existing_supabase'->'tables'->'${table}'))
      union all
      (select value from jsonb_array_elements(doc->'existing_supabase'->'tables'->'${table}') except select to_jsonb(t) from public."${table}" t)
    ) then raise exception 'Existing Supabase ${table} differs from baseline; capture again'; end if;`;
  }).join("\n");
}

const verification = `
do $verify$
declare doc jsonb;
begin
  select document into strict doc from frc190_baserow_stage.snapshots where id = ${snapshotId};
  if (select document_sha256 from frc190_baserow_stage.snapshots where id = ${snapshotId}) <> '${expectedDigest}' then
    raise exception 'Snapshot digest differs';
  end if;
  if exists (
    (select (t->>'id')::bigint, t->'fields' from jsonb_array_elements(doc->'tables') t
      except select table_id, fields from frc190_baserow_stage.source_tables where snapshot_id = ${snapshotId})
    union all
    (select table_id, fields from frc190_baserow_stage.source_tables where snapshot_id = ${snapshotId}
      except select (t->>'id')::bigint, t->'fields' from jsonb_array_elements(doc->'tables') t)
  ) then raise exception 'Staged field schemas differ'; end if;
  if exists (
    (select (t->>'id')::bigint, (r->>'id')::bigint, r from jsonb_array_elements(doc->'tables') t cross join lateral jsonb_array_elements(t->'rows') r
      except select table_id, row_id, payload from frc190_baserow_stage.source_rows where snapshot_id = ${snapshotId})
    union all
    (select table_id, row_id, payload from frc190_baserow_stage.source_rows where snapshot_id = ${snapshotId}
      except select (t->>'id')::bigint, (r->>'id')::bigint, r from jsonb_array_elements(doc->'tables') t cross join lateral jsonb_array_elements(t->'rows') r)
  ) then raise exception 'Staged rows differ from original snapshot'; end if;
  if exists (
    (select value from jsonb_array_elements(doc->'links')
      except select to_jsonb(l) - 'snapshot_id' - 'internal_target_table_id' from frc190_baserow_stage.source_links l where snapshot_id = ${snapshotId})
    union all
    (select to_jsonb(l) - 'snapshot_id' - 'internal_target_table_id' from frc190_baserow_stage.source_links l where snapshot_id = ${snapshotId}
      except select value from jsonb_array_elements(doc->'links'))
  ) then raise exception 'Staged relationships differ'; end if;
  if exists (
    (select ordinality::integer, value from jsonb_array_elements(doc->'qc_references') with ordinality
      except select ordinal, provenance from frc190_baserow_stage.qc_references where snapshot_id = ${snapshotId})
    union all
    (select ordinal, provenance from frc190_baserow_stage.qc_references where snapshot_id = ${snapshotId}
      except select ordinality::integer, value from jsonb_array_elements(doc->'qc_references') with ordinality)
  ) then raise exception 'QC reference mapping differs'; end if;
  if exists (select 1 from frc190_baserow_stage.qc_references where snapshot_id = ${snapshotId}
    and (requirement_table_id <> 1119642 or requirement_id <> (provenance->>'requirement_id')::bigint)) then
    raise exception 'QC reference target differs';
  end if;
end;
$verify$;
select '${document.id}' as snapshot_id, true as verified,
  (select count(*) from frc190_baserow_stage.source_tables where snapshot_id = ${snapshotId}) as tables,
  (select count(*) from frc190_baserow_stage.source_rows where snapshot_id = ${snapshotId}) as rows,
  (select count(*) from frc190_baserow_stage.source_links where snapshot_id = ${snapshotId} and not external) as internal_links,
  (select count(*) from frc190_baserow_stage.source_links where snapshot_id = ${snapshotId} and external) as external_links,
  (select count(*) from frc190_baserow_stage.qc_references where snapshot_id = ${snapshotId}) as qc_references,
  jsonb_build_array(${Object.keys(document.existing_supabase.tables).map((table) => `
    (with baseline as (
      select value as v from frc190_baserow_stage.snapshots s,
      lateral jsonb_array_elements(s.document->'existing_supabase'->'tables'->'${table}')
      where s.id = ${snapshotId}
    ), compared as (
      select b.v as old, to_jsonb(t) as current from baseline b full join public."${table}" t on t.id::text = b.v->>'id'
    ) select jsonb_build_object('table', '${table}',
      'added', (select count(*) from compared where old is null),
      'removed', (select count(*) from compared where current is null),
      'changed_columns', coalesce((select jsonb_agg(distinct k.key) from compared c,
        lateral jsonb_object_keys(c.old || c.current) k(key)
        where c.old is not null and c.current is not null and c.old->k.key is distinct from c.current->k.key), '[]'::jsonb))
    )`).join(",")}) as live_baseline_drift;
`;

const sql = `-- Private, additive staging transaction. No public/auth/storage writes.
begin isolation level repeatable read;
set local statement_timeout = '120s';
select pg_advisory_xact_lock(190, 515011);
do $import$
declare doc jsonb := ${sqlLiteral(document)};
begin
  ${baselineChecks()}
  if exists (select 1 from frc190_baserow_stage.snapshots where id = ${snapshotId} and (document <> doc or document_sha256 <> '${expectedDigest}')) then
    raise exception 'Conflicting snapshot ID; refusing to overwrite';
  end if;
  insert into frc190_baserow_stage.snapshots(id, document_sha256, document)
    values (${snapshotId}, '${expectedDigest}', doc) on conflict do nothing;
  insert into frc190_baserow_stage.source_tables(snapshot_id, table_id, fields)
    select ${snapshotId}, (t->>'id')::bigint, t->'fields' from jsonb_array_elements(doc->'tables') t on conflict do nothing;
  insert into frc190_baserow_stage.source_rows(snapshot_id, table_id, row_id, payload)
    select ${snapshotId}, (t->>'id')::bigint, (r->>'id')::bigint, r
    from jsonb_array_elements(doc->'tables') t cross join lateral jsonb_array_elements(t->'rows') r on conflict do nothing;
  insert into frc190_baserow_stage.source_links(snapshot_id, source_table_id, source_row_id, field_id, position, target_table_id, target_row_id, external)
    select ${snapshotId}, l.source_table_id, l.source_row_id, l.field_id, l.position, l.target_table_id, l.target_row_id, l.external
    from jsonb_to_recordset(doc->'links') as l(source_table_id bigint, source_row_id bigint, field_id bigint, position integer, target_table_id bigint, target_row_id bigint, external boolean)
    on conflict do nothing;
  insert into frc190_baserow_stage.qc_references(snapshot_id, ordinal, requirement_id, provenance)
    select ${snapshotId}, ordinality::integer, (value->>'requirement_id')::bigint, value
    from jsonb_array_elements(doc->'qc_references') with ordinality on conflict do nothing;
end;
$import$;
${verification}
commit;
`;
if (!verifyOnly) await writeFile(resolve(dirname(file), "stage.sql"), sql, { flag: "wx" });
await writeFile(resolve(dirname(file), "verify.sql"), `begin isolation level repeatable read read only;\n${verification}\ncommit;\n`, { flag: verifyOnly ? "w" : "wx" });
console.log(JSON.stringify({ prepared: true, snapshot_id: document.id, project_ref: projectRef,
  stage_sql: resolve(dirname(file), "stage.sql"), verify_sql: resolve(dirname(file), "verify.sql"),
  bytes: Buffer.byteLength(sql), remote_writes: 0 }, null, 2));
