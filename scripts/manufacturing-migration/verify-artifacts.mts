import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { digest } from "./core.mts";

function privatePath(input: string): string {
  const file = resolve(input);
  const child = relative(resolve("migration-artifacts"), file);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error("Expected an artifact under migration-artifacts");
  return file;
}
if (process.argv.length !== 4) throw new Error("Usage: verify-artifacts.mts <original snapshot.json> <post-import snapshot.json>");
const originalPath = privatePath(process.argv[2]);
const latestPath = privatePath(process.argv[3]);
const directory = dirname(originalPath);
const readJson = async (file: string) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const original = await readJson(originalPath);
const latest = await readJson(latestPath);
for (const [snapshot, file] of [[original, originalPath], [latest, latestPath]] as const) {
  const expected = (await readFile(resolve(dirname(file), "snapshot.sha256"), "utf8")).trim();
  if (digest(snapshot) !== expected) throw new Error(`Local snapshot checksum mismatch: ${file}`);
}
const staged = (await readJson(resolve(directory, "staged-document.json"))).rows;
if (!Array.isArray(staged) || staged.length !== 1) throw new Error("Expected one staged snapshot returned from Supabase");
const before = (await readJson(resolve(directory, "audit-before.json"))).rows;
const after = (await readJson(resolve(directory, "audit-after.json"))).rows;
if (before?.length !== 1 || after?.length !== 1) throw new Error("Missing preservation audit");
const databaseVerification = (await readJson(resolve(directory, "database-verification.json"))).rows;
if (databaseVerification?.length !== 1 || databaseVerification[0].snapshot_id !== original.id || databaseVerification[0].verified !== true) {
  throw new Error("Missing independent database row/link verification");
}
const checks = {
  staged_document_matches_original: digest(staged[0].document) === digest(original),
  staged_sha256_matches_original: staged[0].document_sha256 === digest(original),
  source_unchanged_after_import: original.source_digest === latest.source_digest,
  existing_supabase_records_and_api_schema_unchanged: original.baseline_digest === latest.baseline_digest,
  existing_auth_storage_and_schema_unchanged: digest(before[0]) === digest(after[0]),
  excluded_tables_absent: original.tables.every((table: { id: number }) => ![1119643, 1126322].includes(table.id)),
};
const report = { snapshot_id: original.id, captured_at: original.captured_at,
  staged_at: staged[0].staged_at, checked_at: new Date().toISOString(), drift_checked_at: latest.captured_at,
  checks, database: databaseVerification[0], existing_supabase: { auth_users: before[0].auth_users,
    profiles: original.existing_supabase.tables.profiles.length,
    qc_reviews: original.existing_supabase.tables.quality_control.length,
    notifications: original.existing_supabase.tables.notifications.length },
  cutover: false, production_configuration_changed: false,
  file_binaries_copied: false, attachment_references_preserved: original.attachments.length,
};
await writeFile(resolve(directory, "validation.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
if (Object.values(checks).some((ok) => !ok)) throw new Error("One or more preservation/drift checks failed; do not cut over");
