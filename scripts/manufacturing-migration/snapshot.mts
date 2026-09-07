import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, digest, readBaserowPages, validateQc, validateTables, type Field, type SourceTable } from "./core.mts";

const tableCatalog = [
  { id: 1119642, name: "Production Requirements" }, { id: 1119645, name: "Assemblies" },
  { id: 1119641, name: "Parts" }, { id: 1169282, name: "Operations" },
  { id: 1119639, name: "Sync Runs" }, { id: 1170619, name: "Finishing" },
];
const excludedTableIds = [1119643, 1126322];
const baserowUrl = (process.env.BASEROW_API_URL ?? "https://api.baserow.io").replace(/\/$/, "");
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const baserowToken = process.env.BASEROW_API_TOKEN;
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !baserowToken || !serviceKey) throw new Error("Existing Baserow and Supabase credentials are required");
if (process.argv.length > 2) throw new Error("snapshot takes no arguments; each invocation creates a new private snapshot");
const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
const linkedRef = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
if (projectRef !== linkedRef) throw new Error("Supabase URL and linked CLI project differ; refusing to proceed");
for (const [key, expected] of Object.entries({ BASEROW_OPERATIONS_TABLE_ID: 1169282, BASEROW_REQUIREMENTS_TABLE_ID: 1119642,
  BASEROW_PARTS_TABLE_ID: 1119641, BASEROW_FINISHING_TABLE_ID: 1170619 })) {
  if (process.env[key] && Number(process.env[key]) !== expected) throw new Error(`Unexpected active database configuration: ${key}`);
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  // This exporter has no write-capable HTTP path. Never forward credentials through redirects.
  const response = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Read failed (${response.status}) at ${new URL(url).pathname}`);
  return response.json();
}
const baserowHeaders = { Authorization: `Token ${baserowToken}` };
const supabaseHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

async function captureBaserow(): Promise<SourceTable[]> {
  const pending = tableCatalog.map((table) => table.id);
  const tables: SourceTable[] = [];
  while (pending.length) {
    const id = pending.shift()!;
    const fields = await getJson(`${baserowUrl}/api/database/fields/table/${id}/`, baserowHeaders) as Field[];
    if (!Array.isArray(fields)) throw new Error(`Invalid schema for ${id}`);
    const rows = await readBaserowPages(async (page) => await getJson(
      `${baserowUrl}/api/database/rows/table/${id}/?user_field_names=true&size=200&page=${page}`,
      baserowHeaders,
    ) as Awaited<ReturnType<Parameters<typeof readBaserowPages>[0]>>);
    tables.push({ id, fields: fields.sort((a, b) => a.id - b.id), rows });
    for (const field of fields) if (field.type === "link_row" && field.link_row_table_id
      && !excludedTableIds.includes(field.link_row_table_id)
      && !tables.some((t) => t.id === field.link_row_table_id) && !pending.includes(field.link_row_table_id)) {
      pending.push(field.link_row_table_id);
    }
    console.log(`Read table ${id}: ${rows.length} rows`);
  }
  return tables.sort((a, b) => a.id - b.id);
}

async function captureSupabase() {
  const schema = await getJson(`${supabaseUrl}/rest/v1/`, supabaseHeaders) as { definitions: Record<string, unknown> };
  // Inventory all existing public tables exposed by the Data API, not just QC.
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const name of Object.keys(schema.definitions).sort()) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsupported Supabase table name: ${name}`);
    const rows: Record<string, unknown>[] = [];
    let expected: number | undefined;
    for (let offset = 0; ; ) {
      const response = await fetch(`${supabaseUrl}/rest/v1/${name}?select=*&order=id.asc&offset=${offset}&limit=500`, {
        method: "GET", headers: { ...supabaseHeaders, Prefer: "count=exact" },
        redirect: "error", signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Unable to snapshot Supabase ${name} (${response.status})`);
      const countText = response.headers.get("content-range")?.split("/")[1];
      const count = countText === undefined || countText === "*" ? NaN : Number(countText);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Missing exact Supabase count for ${name}`);
      expected ??= count;
      if (count !== expected) throw new Error(`Supabase ${name} changed during capture`);
      const page = await response.json() as Record<string, unknown>[];
      if (!Array.isArray(page)) throw new Error(`Invalid Supabase page for ${name}`);
      rows.push(...page);
      if (rows.length > count || new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error(`Duplicate Supabase rows for ${name}`);
      if (rows.length === count) break;
      if (!page.length) throw new Error(`Truncated Supabase snapshot for ${name}`);
      offset += page.length;
    }
    tables[name] = rows;
  }
  return { schema, tables };
}

const startedAt = new Date().toISOString();
const baseline = await captureSupabase();
const tables = await captureBaserow();
const links = validateTables(tables, excludedTableIds);
const qcReferences = validateQc(tables, baseline.tables.quality_control ?? [], 1169282, 1119642);
const repeat = await captureBaserow();
if (digest(tables) !== digest(repeat)) throw new Error("Baserow changed between full reads. No import prepared; capture again when stable.");
const baselineRepeat = await captureSupabase();
if (digest(baseline) !== digest(baselineRepeat)) throw new Error("Existing Supabase records changed during capture. No import prepared; retry.");

const warnings: string[] = [];
const profileIds = new Set((baseline.tables.profiles ?? []).map((row) => row.id));
const operationRows = tables.find((table) => table.id === 1169282)!.rows;
let claimed = 0, completed = 0, ledgers = 0;
for (const row of operationRows) {
  const raw = row["Quantity Ledger"];
  claimed += Number(row["Claimed Quantity"] ?? 0);
  completed += Number(row["Completed Quantity"] ?? 0);
  if (typeof raw !== "string" || !raw.trim()) continue;
  ledgers++;
  try {
    const ledger = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(ledger)) throw new Error("not an array");
    if (ledger.some((item) => !item || typeof item !== "object")) throw new Error("invalid allocation");
    for (const item of ledger) {
      if (!profileIds.has(item.userId) && !String(item.userId).startsWith("legacy:")) warnings.push(`Operation ${row.id}: claimant has no current profile`);
      if (![item.claimed, item.completed].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) warnings.push(`Operation ${row.id}: nonstandard ledger quantity retained`);
    }
    if (ledger.reduce((n, item) => n + Number(item.claimed ?? 0), 0) !== Number(row["Claimed Quantity"] ?? 0)
      || ledger.reduce((n, item) => n + Number(item.completed ?? 0), 0) !== Number(row["Completed Quantity"] ?? 0)) {
      warnings.push(`Operation ${row.id}: stored quantities differ from ledger; both retained without repair`);
    }
  } catch { warnings.push(`Operation ${row.id}: malformed quantity ledger retained verbatim`); }
}
const attachments = tables.flatMap((table) => table.fields.filter((field) => field.type === "file").flatMap((field) =>
  table.rows.flatMap((row) => (Array.isArray(row[field.name]) ? row[field.name] as Record<string, unknown>[] : []).map((file, position) =>
    ({ table_id: table.id, row_id: row.id, field_id: field.id, position, metadata: file })))));
const snapshot = {
  version: 1, id: randomUUID(), started_at: startedAt, captured_at: new Date().toISOString(),
  source_url: baserowUrl, source_database_id: 515011, project_ref: projectRef,
  source_digest: digest(tables), baseline_digest: digest(baseline), table_catalog: tableCatalog,
  excluded_table_ids: excludedTableIds,
  tables, links, qc_references: qcReferences, existing_supabase: baseline, attachments,
};
const report = {
  snapshot_id: snapshot.id, captured_at: snapshot.captured_at, project_ref: projectRef,
  source_digest: snapshot.source_digest, baseline_digest: snapshot.baseline_digest,
  tables: tables.map((table) => ({ id: table.id, name: tableCatalog.find((item) => item.id === table.id)?.name ?? "Linked table",
    rows: table.rows.length, fields: table.fields.length, sha256: digest(table) })),
  rows: tables.reduce((n, table) => n + table.rows.length, 0), relationships: links.length,
  external_relationships: links.filter((link) => link.external).length, excluded_table_ids: excludedTableIds,
  qc_reviews: qcReferences.length, existing_supabase: Object.fromEntries(Object.entries(baseline.tables).map(([key, rows]) => [key, { rows: rows.length, sha256: digest(rows) }])),
  quantities: { stored_claimed: claimed, stored_completed: completed, ledger_rows: ledgers },
  attachment_references: attachments.length, warnings: [...new Set(warnings)],
  stable_double_read: true, baserow_writes: 0, existing_supabase_writes: 0, cutover: false,
};
const directory = resolve("migration-artifacts", `${snapshot.captured_at.replace(/[:.]/g, "-")}_${snapshot.id}`);
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "snapshot.json"), `${canonical(snapshot)}\n`, { flag: "wx" });
await writeFile(resolve(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
await writeFile(resolve(directory, "snapshot.sha256"), `${digest(snapshot)}\n`, { flag: "wx" });
console.log(JSON.stringify({ directory, ...report }, null, 2));
