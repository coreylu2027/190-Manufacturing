import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { digest } from "./core.mts";

const PARTS_TABLE_ID = 1119641;
const BUCKET = "manufacturing-files";

interface AttachmentReference {
  table_id: number;
  row_id: number;
  field_id: number;
  position: number;
  metadata: Record<string, unknown>;
}

interface StoredAttachment {
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

function allowedSourceUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  return url.protocol === "https:" && (
    hostname === "files.baserow.io"
    || /^baserow-backend-production\d+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(hostname)
  );
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateFileSignature(kind: StoredAttachment["kind"], bytes: Uint8Array, index: number) {
  const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const suffix = new TextDecoder("ascii").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  if (kind === "drawing-pdf" && (!prefix.startsWith("%PDF-") || !suffix.includes("%%EOF"))) {
    throw new Error(`Attachment ${index + 1} is not a complete PDF`);
  }
  if (kind === "step" && (!prefix.includes("ISO-10303-21;") || !suffix.includes("END-ISO-10303-21;"))) {
    throw new Error(`Attachment ${index + 1} is not a complete STEP exchange file`);
  }
}

function retryDelay(attempt: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
}

const snapshotPath = resolve(process.argv.find((argument, index) => index > 1 && !argument.startsWith("--")) ?? "");
const artifactRelativePath = relative(resolve("migration-artifacts"), snapshotPath);
if (!snapshotPath || artifactRelativePath.startsWith("..") || isAbsolute(artifactRelativePath)) {
  throw new Error("Supply a private staged snapshot.json under migration-artifacts");
}
if (!process.argv.includes("--apply")) throw new Error("Pass --apply to copy and verify attachment bytes");

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
  project_ref: string;
  attachments: AttachmentReference[];
  tables: Array<{ id: number; fields: Array<{ id: number; name: string; type: string }> }>;
};
const expectedSnapshotHash = (await readFile(resolve(dirname(snapshotPath), "snapshot.sha256"), "utf8")).trim();
const linkedProject = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
if (digest(snapshot) !== expectedSnapshotHash || snapshot.project_ref !== linkedProject) {
  throw new Error("Snapshot integrity/project mismatch");
}

const partsTable = snapshot.tables.find((table) => table.id === PARTS_TABLE_ID);
if (!partsTable) throw new Error("Parts table is absent from the staged snapshot");
const fieldKinds = new Map<number, StoredAttachment["kind"]>();
for (const field of partsTable.fields) {
  if (field.name === "Drawing PDF" && field.type === "file") fieldKinds.set(field.id, "drawing-pdf");
  if (field.name === "STEP File" && field.type === "file") fieldKinds.set(field.id, "step");
}
if (fieldKinds.size !== 2) throw new Error("Expected the Drawing PDF and STEP File source fields");

const references = snapshot.attachments
  .filter((attachment) => attachment.table_id === PARTS_TABLE_ID && fieldKinds.has(attachment.field_id))
  .sort((a, b) => a.row_id - b.row_id || a.field_id - b.field_id || a.position - b.position);
if (references.length !== snapshot.attachments.length || references.length === 0) {
  throw new Error("Snapshot contains unsupported or missing attachment references");
}
const identities = new Set(references.map((attachment) => `${attachment.row_id}/${attachment.field_id}/${attachment.position}`));
if (identities.size !== references.length) throw new Error("Duplicate attachment reference in snapshot");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Supabase server-secret configuration is required");
if (new URL(url).hostname.split(".")[0] !== linkedProject) throw new Error("Supabase URL and linked project differ");
const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: existingBucket, error: bucketReadError } = await supabase.storage.getBucket(BUCKET);
if (bucketReadError) {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ["application/pdf", "application/step"],
  });
  if (error) throw new Error(`Unable to create private attachment bucket: ${error.message}`);
} else if (existingBucket.public) {
  throw new Error("The manufacturing attachment bucket must be private");
}

const migrated: StoredAttachment[] = [];
let next = 0;
const workers = Array.from({ length: 6 }, async () => {
  while (true) {
    const index = next++;
    const attachment = references[index];
    if (!attachment) return;
    const sourceUrl = String(attachment.metadata.url ?? "");
    if (!allowedSourceUrl(sourceUrl)) throw new Error(`Attachment ${index + 1} has an unapproved source host`);
    const response = await fetch(sourceUrl, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Unable to download attachment ${index + 1} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const declaredSize = Number(attachment.metadata.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize !== bytes.byteLength) {
      throw new Error(`Attachment ${index + 1} size differs from preserved metadata`);
    }
    const hash = sha256(bytes);
    const kind = fieldKinds.get(attachment.field_id)!;
    validateFileSignature(kind, bytes, index);
    const contentType = String(attachment.metadata.mime_type ?? "");
    const expectedContentType = kind === "drawing-pdf" ? "application/pdf" : "application/step";
    if (contentType !== expectedContentType) throw new Error(`Attachment ${index + 1} has an unexpected content type`);
    const originalName = String(attachment.metadata.visible_name ?? attachment.metadata.name ?? "").trim();
    if (!originalName) throw new Error(`Attachment ${index + 1} has no original name`);
    const storagePath = `sha256/${hash.slice(0, 2)}/${hash}.${kind === "drawing-pdf" ? "pdf" : "step"}`;

    let { data: downloaded } = await supabase.storage.from(BUCKET).download(storagePath);
    if (!downloaded) {
      let uploadMessage = "unknown error";
      let uploadAccepted = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
          contentType,
          cacheControl: "31536000",
          upsert: false,
        });
        uploadMessage = uploadError?.message ?? "";
        if (!uploadError || /already exists|duplicate/i.test(uploadMessage)) {
          uploadAccepted = true;
          break;
        }
        await retryDelay(attempt);
      }
      if (!uploadAccepted) throw new Error(`Unable to upload attachment ${index + 1}: ${uploadMessage}`);
    }

    let verifyMessage = "empty object";
    for (let attempt = 0; !downloaded && attempt < 3; attempt += 1) {
      const result = await supabase.storage.from(BUCKET).download(storagePath);
      downloaded = result.data;
      verifyMessage = result.error?.message ?? verifyMessage;
      if (!downloaded) await retryDelay(attempt);
    }
    if (!downloaded) throw new Error(`Unable to verify attachment ${index + 1}: ${verifyMessage}`);
    const storedBytes = new Uint8Array(await downloaded.arrayBuffer());
    if (storedBytes.byteLength !== bytes.byteLength || sha256(storedBytes) !== hash) {
      throw new Error(`Stored attachment ${index + 1} failed byte verification`);
    }

    const record: StoredAttachment = {
      part_id: attachment.row_id,
      kind,
      position: attachment.position,
      source_field_id: attachment.field_id,
      source_url: sourceUrl,
      original_name: originalName,
      content_type: contentType,
      byte_size: bytes.byteLength,
      sha256: hash,
      storage_bucket: BUCKET,
      storage_path: storagePath,
    };
    const { error: registerError } = await supabase.rpc("manufacturing_register_attachment", {
      p_part_id: record.part_id,
      p_kind: record.kind,
      p_position: record.position,
      p_source_field_id: record.source_field_id,
      p_source_url: record.source_url,
      p_source_metadata: attachment.metadata,
      p_original_name: record.original_name,
      p_content_type: record.content_type,
      p_byte_size: record.byte_size,
      p_sha256: record.sha256,
      p_storage_bucket: record.storage_bucket,
      p_storage_path: record.storage_path,
      p_verified_at: new Date().toISOString(),
    });
    if (registerError) throw new Error(`Unable to register attachment ${index + 1}: ${registerError.message}`);
    migrated[index] = record;
    if ((index + 1) % 20 === 0 || index + 1 === references.length) {
      console.log(`Copied and verified ${migrated.filter(Boolean).length}/${references.length} attachments`);
    }
  }
});
await Promise.all(workers);

const { data: storedManifest, error: manifestError } = await supabase.rpc("manufacturing_attachment_manifest");
if (manifestError || !Array.isArray(storedManifest)) throw new Error(`Unable to verify attachment manifest: ${manifestError?.message ?? "invalid response"}`);
const expectedManifest = [...migrated].sort((a, b) => a.part_id - b.part_id || a.kind.localeCompare(b.kind) || a.position - b.position);
if (digest(storedManifest) !== digest(expectedManifest)) throw new Error("Stored attachment manifest differs from verified source files");

console.log(JSON.stringify({
  copied_and_verified: migrated.length,
  unique_objects: new Set(migrated.map((item) => item.storage_path)).size,
  bytes: migrated.reduce((total, item) => total + item.byte_size, 0),
  bucket: BUCKET,
  public: false,
}, null, 2));
