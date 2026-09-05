import { NextResponse } from "next/server";
import { z } from "zod";

import { getAppUser } from "@/lib/auth";
import { updatePartLocation } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { storageLocationSchema } from "@/lib/storage-locations";

const locationSchema = z.object({
  location: storageLocationSchema.nullable(),
}).strict();

export async function PATCH(request: Request, { params }: RouteContext<"/api/requirements/[id]/location">) {
  const currentUser = await getAppUser();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });

  const parsed = locationSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { id } = await params;
  const requirementId = Number(id);
  if (!Number.isInteger(requirementId)) {
    return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });
  }

  try {
    return NextResponse.json(await updatePartLocation(requirementId, parsed.data.location, currentUser));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update the part location" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 },
    );
  }
}
