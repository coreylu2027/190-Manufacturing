import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export type ManufacturingFileKind = "drawing-pdf" | "step";

interface StoredFile {
  bucket: string;
  path: string;
  name: string;
  content_type: string;
  byte_size: number;
  sha256: string;
}

interface StoredPreview {
  bucket: string;
  path: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  source_sha256: string;
}

export class ManufacturingFileError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function safeFileName(value: string, fallback: string) {
  const leaf = value.split(/[\\/]/).pop()?.trim() || fallback;
  return leaf.replace(/[\r\n]/g, "").slice(0, 240) || fallback;
}

function validStoredFile(value: unknown): value is StoredFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return file.bucket === "manufacturing-files"
    && typeof file.path === "string" && /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.(pdf|step)$/.test(file.path)
    && typeof file.name === "string" && file.name.length > 0
    && (file.content_type === "application/pdf" || file.content_type === "application/step")
    && Number.isSafeInteger(file.byte_size) && Number(file.byte_size) >= 0
    && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256);
}

function validStoredPreview(value: unknown): value is StoredPreview {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return file.bucket === "manufacturing-files"
    && typeof file.path === "string" && /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.glb$/.test(file.path)
    && file.content_type === "model/gltf-binary"
    && Number.isSafeInteger(file.byte_size) && Number(file.byte_size) > 0
    && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256)
    && typeof file.source_sha256 === "string" && /^[0-9a-f]{64}$/.test(file.source_sha256);
}

export async function storedManufacturingFileRedirect(requirementId: number, kind: ManufacturingFileKind, fallbackName: string) {
  const admin = createAdminClient();
  if (!admin) throw new ManufacturingFileError("Supabase file storage is not configured", 503);
  const { data, error } = await admin.rpc("manufacturing_file_for_requirement", {
    p_requirement_id: requirementId,
    p_kind: kind,
  });
  if (error) throw new ManufacturingFileError("Unable to resolve the stored manufacturing file", 502);
  if (data === null) throw new ManufacturingFileError("File not found", 404);
  if (!validStoredFile(data)) throw new ManufacturingFileError("Stored manufacturing file metadata is invalid", 502);

  const fileName = safeFileName(data.name, fallbackName);
  const { data: signed, error: signingError } = await admin.storage.from(data.bucket).createSignedUrl(
    data.path,
    5 * 60,
    kind === "step" ? { download: fileName } : undefined,
  );
  if (signingError || !signed?.signedUrl) throw new ManufacturingFileError("Unable to authorize the stored manufacturing file", 502);

  return new Response(null, {
    status: 307,
    headers: {
      Location: signed.signedUrl,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function storedManufacturingPreviewResponse(requirementId: number, request: Request) {
  const admin = createAdminClient();
  if (!admin) throw new ManufacturingFileError("Supabase file storage is not configured", 503);
  const { data, error } = await admin.rpc("manufacturing_preview_for_requirement", {
    p_requirement_id: requirementId,
  });
  if (error) throw new ManufacturingFileError("Unable to resolve the stored manufacturing preview", 502);
  if (data === null) throw new ManufacturingFileError("A 3D preview has not been generated for this part", 404);
  if (!validStoredPreview(data)) throw new ManufacturingFileError("Stored manufacturing preview metadata is invalid", 502);

  const etag = `"sha256-${data.sha256}"`;
  const headers = {
    "Cache-Control": "private, no-cache",
    "Content-Type": data.content_type,
    "ETag": etag,
    "X-Content-SHA256": data.sha256,
    "X-Preview-Source-SHA256": data.source_sha256,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const { data: blob, error: downloadError } = await admin.storage.from(data.bucket).download(data.path);
  if (downloadError || !blob) throw new ManufacturingFileError("Unable to retrieve the stored manufacturing preview", 502);
  if (blob.size !== data.byte_size) throw new ManufacturingFileError("Stored manufacturing preview failed its size check", 502);

  return new Response(blob.stream(), {
    status: 200,
    headers: {
      ...headers,
      "Content-Length": String(data.byte_size),
    },
  });
}
