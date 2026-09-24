import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { MAX_OVERRIDE_FILE_BYTES, type OverrideFileKind } from "@/lib/engineering-overrides";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeManufacturingFileName } from "./file-names";

// Browsers upload to a random staging path with a signed URL, which avoids the
// serverless request-size limit. The server then verifies the bytes and copies
// them to the same content-addressed layout the sync uses.
const BUCKET = "manufacturing-files";
const STAGING_PATH = /^admin-uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|step)$/;
const KINDS = {
  "drawing-pdf": { extension: "pdf", contentType: "application/pdf", names: /\.pdf$/i, label: "a PDF drawing" },
  step: { extension: "step", contentType: "application/step", names: /\.(step|stp)$/i, label: "a STEP file" },
} as const;

export class FileOverrideError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function storage() {
  const admin = createAdminClient();
  if (!admin) throw new FileOverrideError("Supabase file storage is not configured", 503);
  return admin.storage.from(BUCKET);
}

function validateName(kind: OverrideFileKind, name: string) {
  const fileName = safeManufacturingFileName(name, "");
  if (!fileName || !KINDS[kind].names.test(fileName)) throw new FileOverrideError(`Choose ${KINDS[kind].label}`);
  return fileName;
}

function validateSignature(kind: OverrideFileKind, bytes: Uint8Array) {
  const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const suffix = new TextDecoder("ascii").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  if (kind === "drawing-pdf" && (!prefix.startsWith("%PDF-") || !suffix.includes("%%EOF"))) {
    throw new FileOverrideError("The uploaded file is not a complete PDF");
  }
  if (kind === "step" && (!prefix.includes("ISO-10303-21;") || !suffix.includes("END-ISO-10303-21;"))) {
    throw new FileOverrideError("The uploaded file is not a complete STEP exchange file");
  }
}

export async function createStagedUpload(kind: OverrideFileKind, name: string, byteSize: number) {
  validateName(kind, name);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > MAX_OVERRIDE_FILE_BYTES) {
    throw new FileOverrideError(`Files must be smaller than ${MAX_OVERRIDE_FILE_BYTES / 1024 / 1024} MB`);
  }
  const path = `admin-uploads/${randomUUID()}.${KINDS[kind].extension}`;
  const { data, error } = await storage().createSignedUploadUrl(path);
  if (error || !data?.token) throw new FileOverrideError("Unable to authorize the upload", 502);
  return { path, token: data.token, contentType: KINDS[kind].contentType };
}

/** Verifies a staged upload, stores it by SHA-256, and removes the staging object. */
export async function promoteStagedUpload(kind: OverrideFileKind, stagingPath: string, name: string) {
  const fileName = validateName(kind, name);
  const match = STAGING_PATH.exec(stagingPath);
  if (!match || match[1] !== KINDS[kind].extension) throw new FileOverrideError("Invalid upload");
  const bucket = storage();
  try {
    const { data: blob, error } = await bucket.download(stagingPath);
    if (error || !blob) throw new FileOverrideError("The upload was not found. Try again.", 404);
    if (blob.size <= 0 || blob.size > MAX_OVERRIDE_FILE_BYTES) throw new FileOverrideError("The uploaded file is empty or too large");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    validateSignature(kind, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = `sha256/${sha256.slice(0, 2)}/${sha256}.${KINDS[kind].extension}`;
    // Never overwrite: an existing object at this path already holds these verified bytes.
    const { error: uploadError } = await bucket.upload(path, bytes, { contentType: KINDS[kind].contentType, upsert: false });
    if (uploadError && !/exist|duplicate/i.test(uploadError.message)) throw new FileOverrideError("Unable to store the verified file", 502);
    return { name: fileName, sha256, byteSize: bytes.byteLength };
  } finally {
    await bucket.remove([stagingPath]).catch(() => undefined);
  }
}
