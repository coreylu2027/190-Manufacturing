import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { getCurrentManufacturingSnapshot } from "@/lib/manufacturing/cache";
import { ManufacturingFileError, storedManufacturingPreviewResponse } from "@/lib/manufacturing/files";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });

  const { id } = await params;
  const operationId = Number(id);
  if (!Number.isInteger(operationId)) return NextResponse.json({ error: "Invalid operation ID" }, { status: 400 });

  try {
    const { snapshot: { operations } } = await getCurrentManufacturingSnapshot();
    const operation = operations.find((item) => item.id === operationId);
    if (!operation) return NextResponse.json({ error: "Operation not found" }, { status: 404 });
    if (!operation.requirementId) return NextResponse.json({ error: "Preview not found" }, { status: 404 });
    return storedManufacturingPreviewResponse(operation.requirementId, request);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to open the 3D preview" }, {
      status: error instanceof ManufacturingFileError ? error.status : 502,
    });
  }
}
