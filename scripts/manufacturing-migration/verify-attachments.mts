import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { digest } from "./core.mts";

const PARTS_TABLE_ID = 1119641;
const REQUIREMENTS_TABLE_ID = 1119642;
const BUCKET = "manufacturing-files";

interface ManifestRow {
  part_id: number;
  kind: "drawing-pdf" | "step";
  position: number;
  source_field_id: number;
  source_url: string;
  original_name: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  storage_bucket: string;
  storage_path: string;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function linkedId(value: unknown) {
  return Array.isArray(value) && value.length === 1 && Number.isSafeInteger(value[0]?.id) ? Number(value[0].id) : null;
}

const snapshotPath = resolve(process.argv[2] ?? "");
const artifactRelativePath = relative(resolve("migration-artifacts"), snapshotPath);
if (process.argv.length !== 3 || artifactRelativePath.startsWith("..") || isAbsolute(artifactRelativePath)) {
  throw new Error("Supply a private staged snapshot.json under migration-artifacts");
}
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
  project_ref: string;
  attachments: Array<{ table_id: number; row_id: number; field_id: number; position: number; metadata: Record<string, unknown> }>;
  tables: Array<{ id: number; fields: Array<{ id: number; name: string; type: string }>; rows: Array<Record<string, unknown> & { id: number }> }>;
};
const expectedSnapshotHash = (await readFile(resolve(dirname(snapshotPath), "snapshot.sha256"), "utf8")).trim();
const linkedProject = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
if (digest(snapshot) !== expectedSnapshotHash || snapshot.project_ref !== linkedProject) throw new Error("Snapshot integrity/project mismatch");

const parts = snapshot.tables.find((table) => table.id === PARTS_TABLE_ID);
const requirements = snapshot.tables.find((table) => table.id === REQUIREMENTS_TABLE_ID);
if (!parts || !requirements) throw new Error("Parts or requirements are missing from the snapshot");
const fieldKinds = new Map<number, ManifestRow["kind"]>();
for (const field of parts.fields) {
  if (field.name === "Drawing PDF" && field.type === "file") fieldKinds.set(field.id, "drawing-pdf");
  if (field.name === "STEP File" && field.type === "file") fieldKinds.set(field.id, "step");
}

const expected = snapshot.attachments.map((attachment) => {
  const kind = fieldKinds.get(attachment.field_id);
  if (attachment.table_id !== PARTS_TABLE_ID || !kind) throw new Error("Unsupported attachment reference");
  return {
    key: `${attachment.row_id}/${kind}/${attachment.position}`,
    source_field_id: attachment.field_id,
    source_url: String(attachment.metadata.url ?? ""),
    original_name: String(attachment.metadata.visible_name ?? attachment.metadata.name ?? "").trim(),
    content_type: String(attachment.metadata.mime_type ?? ""),
    byte_size: Number(attachment.metadata.size),
  };
});

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) throw new Error("Supabase secret and publishable configuration is required");
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const anonymous = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });

const { data, error } = await admin.rpc("manufacturing_attachment_manifest");
if (error || !Array.isArray(data)) throw new Error(`Unable to read attachment manifest: ${error?.message ?? "invalid response"}`);
const manifest = data as ManifestRow[];
if (manifest.length !== expected.length) throw new Error("Attachment manifest count differs from the snapshot");
const storedByKey = new Map(manifest.map((row) => [`${row.part_id}/${row.kind}/${row.position}`, row]));
for (const item of expected) {
  const stored = storedByKey.get(item.key);
  if (!stored || stored.source_field_id !== item.source_field_id || stored.source_url !== item.source_url
    || stored.original_name !== item.original_name || stored.content_type !== item.content_type
    || stored.byte_size !== item.byte_size) {
    throw new Error(`Attachment metadata or exact filename differs for ${item.key}`);
  }
}

let nextObject = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (true) {
    const row = manifest[nextObject++];
    if (!row) return;
    const { data: blob, error: downloadError } = await admin.storage.from(row.storage_bucket).download(row.storage_path);
    if (downloadError || !blob) throw new Error(`Unable to download stored object for part ${row.part_id}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength !== row.byte_size || sha256(bytes) !== row.sha256) throw new Error(`Stored hash differs for part ${row.part_id}`);
  }
}));

const attachmentsByPartAndKind = new Map(manifest.map((row) => [`${row.part_id}/${row.kind}`, row]));
const resolverChecks = requirements.rows.flatMap((requirement) => {
  const partId = linkedId(requirement.Part);
  if (!partId) return [];
  return (["drawing-pdf", "step"] as const).flatMap((kind) => {
    const attachment = attachmentsByPartAndKind.get(`${partId}/${kind}`);
    return attachment ? [{ requirementId: requirement.id, kind, attachment }] : [];
  });
});
let nextResolver = 0;
await Promise.all(Array.from({ length: 10 }, async () => {
  while (true) {
    const check = resolverChecks[nextResolver++];
    if (!check) return;
    const { data: resolved, error: resolveError } = await admin.rpc("manufacturing_file_for_requirement", {
      p_requirement_id: check.requirementId,
      p_kind: check.kind,
    });
    if (resolveError || !resolved || resolved.path !== check.attachment.storage_path
      || resolved.name !== check.attachment.original_name || resolved.sha256 !== check.attachment.sha256) {
      throw new Error(`Download resolver differs for requirement ${check.requirementId}/${check.kind}`);
    }
  }
}));

const { error: anonymousManifestError } = await anonymous.rpc("manufacturing_attachment_manifest");
const { error: anonymousDownloadError } = await anonymous.storage.from(BUCKET).download(manifest[0].storage_path);
if (!anonymousManifestError || !anonymousDownloadError) throw new Error("Anonymous attachment access was not denied");

console.log(JSON.stringify({
  snapshot_references: expected.length,
  exact_original_names: expected.length,
  stored_hashes_verified: manifest.length,
  requirement_resolvers_verified: resolverChecks.length,
  bytes_verified: manifest.reduce((total, row) => total + row.byte_size, 0),
  anonymous_catalog_access: "denied",
  anonymous_object_access: "denied",
  bucket: BUCKET,
  public: false,
}, null, 2));
