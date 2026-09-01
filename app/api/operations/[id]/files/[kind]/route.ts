import { NextResponse } from "next/server";

import { getEffectiveAppUser, isAuthRequired } from "@/lib/auth";
import { getOperations } from "@/lib/baserow";

export const dynamic = "force-dynamic";

function safeFileName(value: string, fallback: string) {
  const leaf = value.split(/[\\/]/).pop()?.trim() || fallback;
  return leaf.replace(/[\r\n]/g, "").slice(0, 240) || fallback;
}

function contentDisposition(fileName: string) {
  const ascii = fileName.normalize("NFKD").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function isAllowedFileUrl(value: string) {
  try {
    const url = new URL(value);
    const apiHost = new URL(process.env.BASEROW_API_URL ?? "https://api.baserow.io").host;
    const extraHosts = (process.env.BASEROW_FILE_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
    const allowedHosts = new Set([apiHost.toLowerCase(), "files.baserow.io", ...extraHosts]);
    return (url.protocol === "https:" || (url.protocol === "http:" && extraHosts.includes(url.host.toLowerCase()))) && allowedHosts.has(url.host.toLowerCase());
  } catch {
    return false;
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const user = await getEffectiveAppUser();
  if (isAuthRequired() && !user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (isAuthRequired() && !user?.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });

  const { id, kind } = await params;
  const operationId = Number(id);
  if (!Number.isInteger(operationId)) return NextResponse.json({ error: "Invalid operation ID" }, { status: 400 });
  if (kind !== "drawing-pdf" && kind !== "step") return NextResponse.json({ error: "Invalid file type" }, { status: 400 });

  try {
    const { operations } = await getOperations();
    const operation = operations.find((item) => item.id === operationId);
    if (!operation) return NextResponse.json({ error: "Operation not found" }, { status: 404 });

    const fileUrl = kind === "drawing-pdf" ? operation.drawingPdfUrl : operation.stepUrl;
    const storedName = kind === "drawing-pdf" ? operation.drawingPdfName : operation.stepName;
    const fallbackName = kind === "drawing-pdf" ? `${operation.partNumber}.pdf` : `${operation.partNumber}.step`;
    if (!fileUrl || !storedName) return NextResponse.json({ error: "File not found" }, { status: 404 });
    if (!isAllowedFileUrl(fileUrl)) return NextResponse.json({ error: "File host is not allowed" }, { status: 400 });

    const upstream = await fetch(fileUrl, { cache: "no-store", redirect: "error" });
    if (!upstream.ok || !upstream.body) return NextResponse.json({ error: "Unable to retrieve the file" }, { status: 502 });

    const fileName = safeFileName(storedName, fallbackName);
    const headers = new Headers({
      "Content-Disposition": contentDisposition(fileName),
      "Content-Type": upstream.headers.get("content-type") ?? (kind === "drawing-pdf" ? "application/pdf" : "model/step"),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to open the file" }, { status: 502 });
  }
}
