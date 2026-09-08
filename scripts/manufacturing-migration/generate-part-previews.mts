import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import createOpenCascadeImporter from "occt-import-js";

import { cadMeshesToGlb, inspectGlb } from "../../lib/manufacturing/glb.mts";

const BUCKET = "manufacturing-files";
const CONTENT_TYPE = "model/gltf-binary";
const GENERATOR = "occt-import-js";
const GENERATOR_VERSION = "0.0.23+frc190-glb-v1";
const MINIMUM_BUCKET_LIMIT = 50 * 1024 * 1024;
const TESSELLATION = {
  linearUnit: "millimeter" as const,
  linearDeflectionType: "bounding_box_ratio" as const,
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};

interface PreviewSource {
  attachment_id: number;
  part_id: number;
  original_name: string;
  byte_size: number;
  sha256: string;
  storage_bucket: string;
  storage_path: string;
  preview_source_sha256: string | null;
  preview_generator: string | null;
  preview_generator_version: string | null;
  preview_byte_size: number | null;
  preview_sha256: string | null;
  preview_storage_bucket: string | null;
  preview_storage_path: string | null;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isStoragePath(value: unknown, extension: "step" | "glb") {
  return typeof value === "string" && new RegExp(`^sha256/[0-9a-f]{2}/[0-9a-f]{64}\\.${extension}$`).test(value);
}

function parseSources(value: unknown): PreviewSource[] {
  if (!Array.isArray(value)) throw new Error("Invalid STEP preview source manifest");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid preview source ${index + 1}`);
    const source = item as Record<string, unknown>;
    if (!Number.isSafeInteger(source.attachment_id) || !Number.isSafeInteger(source.part_id)
      || typeof source.original_name !== "string" || !source.original_name
      || !Number.isSafeInteger(source.byte_size) || Number(source.byte_size) <= 0
      || !isHash(source.sha256) || source.storage_bucket !== BUCKET
      || !isStoragePath(source.storage_path, "step")) {
      throw new Error(`Invalid preview source ${index + 1}`);
    }
    return source as unknown as PreviewSource;
  });
}

function validateStep(bytes: Uint8Array, source: PreviewSource) {
  if (bytes.byteLength !== source.byte_size || sha256(bytes) !== source.sha256) {
    throw new Error(`${source.original_name} failed its stored STEP integrity check`);
  }
  const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const suffix = new TextDecoder("ascii").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  if (!prefix.includes("ISO-10303-21;") || !suffix.includes("END-ISO-10303-21;")) {
    throw new Error(`${source.original_name} is not a complete STEP exchange file`);
  }
}

function currentPreviewMetadata(source: PreviewSource) {
  return source.preview_source_sha256 === source.sha256
    && source.preview_generator === GENERATOR
    && source.preview_generator_version === GENERATOR_VERSION
    && Number.isSafeInteger(source.preview_byte_size) && Number(source.preview_byte_size) > 0
    && isHash(source.preview_sha256)
    && source.preview_storage_bucket === BUCKET
    && isStoragePath(source.preview_storage_path, "glb");
}

function retryDelay(attempt: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
}

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = limitArgument ? Number(limitArgument.slice("--limit=".length)) : Number.POSITIVE_INFINITY;
if (!apply) throw new Error("Pass --apply to generate, upload, verify, and register private GLB previews");
if (!(limit === Number.POSITIVE_INFINITY || Number.isSafeInteger(limit) && limit > 0)) {
  throw new Error("--limit must be a positive whole number");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Supabase server-secret configuration is required");
const linkedProject = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
if (new URL(url).hostname.split(".")[0] !== linkedProject) throw new Error("Supabase URL and linked project differ");

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: bucket, error: bucketError } = await supabase.storage.getBucket(BUCKET);
if (bucketError || !bucket) throw new Error(`Private attachment bucket is unavailable: ${bucketError?.message ?? "missing bucket"}`);
if (bucket.public) throw new Error("The manufacturing attachment bucket must remain private");
const mimeTypes = bucket.allowed_mime_types;
const requiresMimeUpdate = Array.isArray(mimeTypes) && !mimeTypes.includes(CONTENT_TYPE);
const requiresSizeUpdate = typeof bucket.file_size_limit === "number" && bucket.file_size_limit < MINIMUM_BUCKET_LIMIT;
if (requiresMimeUpdate || requiresSizeUpdate) {
  const { error } = await supabase.storage.updateBucket(BUCKET, {
    public: false,
    allowedMimeTypes: mimeTypes ? [...new Set([...mimeTypes, CONTENT_TYPE])] : null,
    fileSizeLimit: typeof bucket.file_size_limit === "number"
      ? Math.max(bucket.file_size_limit, MINIMUM_BUCKET_LIMIT)
      : null,
  });
  if (error) throw new Error(`Unable to allow private GLB previews in Storage: ${error.message}`);
}

const { data: sourceData, error: sourceError } = await supabase.rpc("manufacturing_step_preview_sources");
if (sourceError) throw new Error(`Unable to load STEP preview sources: ${sourceError.message}`);
const sources = parseSources(sourceData).slice(0, limit);
const occt = await createOpenCascadeImporter();
let generated = 0;
let skipped = 0;
let totalBytes = 0;

for (const [index, source] of sources.entries()) {
  if (!force && currentPreviewMetadata(source)) {
    const { data: existing } = await supabase.storage.from(BUCKET).download(source.preview_storage_path!);
    if (existing) {
      const existingBytes = new Uint8Array(await existing.arrayBuffer());
      if (existingBytes.byteLength === source.preview_byte_size && sha256(existingBytes) === source.preview_sha256) {
        inspectGlb(existingBytes);
        skipped += 1;
        console.log(`[${index + 1}/${sources.length}] Current preview: ${source.original_name}`);
        continue;
      }
    }
  }

  const { data: stepBlob, error: downloadError } = await supabase.storage.from(source.storage_bucket).download(source.storage_path);
  if (downloadError || !stepBlob) throw new Error(`Unable to download ${source.original_name}: ${downloadError?.message ?? "empty object"}`);
  const stepBytes = new Uint8Array(await stepBlob.arrayBuffer());
  validateStep(stepBytes, source);

  const imported = occt.ReadStepFile(stepBytes, TESSELLATION);
  const glbBytes = cadMeshesToGlb(imported, `${GENERATOR} ${GENERATOR_VERSION}`);
  inspectGlb(glbBytes);
  const previewHash = sha256(glbBytes);
  const previewPath = `sha256/${previewHash.slice(0, 2)}/${previewHash}.glb`;

  let { data: storedPreview } = await supabase.storage.from(BUCKET).download(previewPath);
  if (!storedPreview) {
    let uploadMessage = "unknown error";
    let uploaded = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error } = await supabase.storage.from(BUCKET).upload(previewPath, glbBytes, {
        contentType: CONTENT_TYPE,
        cacheControl: "31536000",
        upsert: false,
      });
      uploadMessage = error?.message ?? "";
      if (!error || /already exists|duplicate/i.test(uploadMessage)) {
        uploaded = true;
        break;
      }
      await retryDelay(attempt);
    }
    if (!uploaded) throw new Error(`Unable to upload ${source.original_name} preview: ${uploadMessage}`);
  }

  let verifyMessage = "empty object";
  for (let attempt = 0; !storedPreview && attempt < 3; attempt += 1) {
    const result = await supabase.storage.from(BUCKET).download(previewPath);
    storedPreview = result.data;
    verifyMessage = result.error?.message ?? verifyMessage;
    if (!storedPreview) await retryDelay(attempt);
  }
  if (!storedPreview) throw new Error(`Unable to verify ${source.original_name} preview: ${verifyMessage}`);
  const verifiedBytes = new Uint8Array(await storedPreview.arrayBuffer());
  if (verifiedBytes.byteLength !== glbBytes.byteLength || sha256(verifiedBytes) !== previewHash) {
    throw new Error(`${source.original_name} preview failed its stored GLB integrity check`);
  }
  inspectGlb(verifiedBytes);

  const { error: registerError } = await supabase.rpc("manufacturing_register_part_preview", {
    p_source_attachment_id: source.attachment_id,
    p_source_sha256: source.sha256,
    p_generator: GENERATOR,
    p_generator_version: GENERATOR_VERSION,
    p_content_type: CONTENT_TYPE,
    p_byte_size: glbBytes.byteLength,
    p_sha256: previewHash,
    p_storage_bucket: BUCKET,
    p_storage_path: previewPath,
    p_verified_at: new Date().toISOString(),
  });
  if (registerError) throw new Error(`Unable to register ${source.original_name} preview: ${registerError.message}`);

  generated += 1;
  totalBytes += glbBytes.byteLength;
  console.log(`[${index + 1}/${sources.length}] Generated preview: ${source.original_name}`);
}

const { data: manifest, error: manifestError } = await supabase.rpc("manufacturing_preview_manifest");
if (manifestError || !Array.isArray(manifest)) {
  throw new Error(`Unable to verify the preview manifest: ${manifestError?.message ?? "invalid response"}`);
}
console.log(JSON.stringify({
  sources: sources.length,
  generated,
  skipped,
  generated_bytes: totalBytes,
  registered_previews: manifest.length,
  bucket: BUCKET,
  public: false,
}, null, 2));
