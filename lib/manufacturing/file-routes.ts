import "server-only";

import { NextResponse } from "next/server";

import { parseId, requireUser } from "@/lib/api-route";
import { getCurrentManufacturingSnapshot } from "./cache";
import { ManufacturingFileError, storedManufacturingFileResponse, storedManufacturingPreviewResponse } from "./files";

// Operations and finishing jobs serve their requirement's stored files the same way.
const SOURCES = {
  operations: { noun: "operation", notFound: "Operation not found" },
  jobs: { noun: "finishing job", notFound: "Finishing job not found" },
} as const;
type Source = keyof typeof SOURCES;

async function authorizedId(source: Source, rawId: string) {
  const { response } = await requireUser();
  if (response) return { response };
  const id = parseId(rawId);
  if (id === null) return { response: NextResponse.json({ error: `Invalid ${SOURCES[source].noun} ID` }, { status: 400 }) };
  return { id };
}

async function workItem(source: Source, id: number, missingMessage: string) {
  const { snapshot } = await getCurrentManufacturingSnapshot();
  const items: Array<{ id: number; requirementId: number | null; partNumber: string }> = snapshot[source];
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new ManufacturingFileError(SOURCES[source].notFound, 404);
  if (!item.requirementId) throw new ManufacturingFileError(missingMessage, 404);
  return { requirementId: item.requirementId, partNumber: item.partNumber };
}

// The stored-file calls are awaited inside try so their errors keep their status here. Only file
// errors keep theirs: any other failure, including a write error from the snapshot read, is a 502.
// Not cached, so a prefetched miss is not reused once the file exists.
function fileError(error: unknown, fallback: string) {
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, {
    status: error instanceof ManufacturingFileError ? error.status : 502,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/** GET handler for the drawing PDF or STEP file of an operation or finishing job. */
export function workItemFileRoute(source: Source) {
  return async (_request: Request, { params }: { params: Promise<{ id: string; kind: string }> }) => {
    const { id: rawId, kind } = await params;
    const auth = await authorizedId(source, rawId);
    if (auth.response) return auth.response;
    if (kind !== "drawing-pdf" && kind !== "step") return NextResponse.json({ error: "Invalid file type" }, { status: 400 });
    try {
      const item = await workItem(source, auth.id, "File not found");
      return await storedManufacturingFileResponse(item.requirementId, kind, `${item.partNumber}.${kind === "drawing-pdf" ? "pdf" : "step"}`);
    } catch (error) {
      return fileError(error, "Unable to open the file");
    }
  };
}

/** GET handler for the 3D preview of an operation or finishing job. */
export function workItemPreviewRoute(source: Source) {
  return async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const auth = await authorizedId(source, (await params).id);
    if (auth.response) return auth.response;
    try {
      const item = await workItem(source, auth.id, "Preview not found");
      return await storedManufacturingPreviewResponse(item.requirementId, request);
    } catch (error) {
      return fileError(error, "Unable to open the 3D preview");
    }
  };
}
