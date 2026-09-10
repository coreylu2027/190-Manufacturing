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
