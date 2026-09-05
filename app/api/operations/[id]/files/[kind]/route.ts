import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { getOperations } from "@/lib/manufacturing";
import { ManufacturingFileError, storedManufacturingFileResponse } from "@/lib/manufacturing/files";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });

  const { id, kind } = await params;
  const operationId = Number(id);
  if (!Number.isInteger(operationId)) return NextResponse.json({ error: "Invalid operation ID" }, { status: 400 });
  if (kind !== "drawing-pdf" && kind !== "step") return NextResponse.json({ error: "Invalid file type" }, { status: 400 });

  try {
    const { operations } = await getOperations();
    const operation = operations.find((item) => item.id === operationId);
    if (!operation) return NextResponse.json({ error: "Operation not found" }, { status: 404 });

    const fallbackName = kind === "drawing-pdf" ? `${operation.partNumber}.pdf` : `${operation.partNumber}.step`;
    if (!operation.requirementId) return NextResponse.json({ error: "File not found" }, { status: 404 });
    return storedManufacturingFileResponse(operation.requirementId, kind, fallbackName);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to open the file" }, {
      status: error instanceof ManufacturingFileError ? error.status : 502,
    });
  }
}
