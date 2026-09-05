import { NextResponse } from "next/server";
import { z } from "zod";

import { getAppUser } from "@/lib/auth";
import { applyFabricationAction } from "@/lib/manufacturing";
import { isShopName } from "@/lib/profile-name";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";

const requestSchema = z.object({
  action: z.enum(["claim", "release", "complete", "undo_complete"]),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });

  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) return NextResponse.json({ error: "Invalid finishing job ID" }, { status: 400 });

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const machinist = user.name;
  if (!isShopName(machinist)) {
    return NextResponse.json({ error: "Set your first name and last initial before recording work", code: "PROFILE_NAME_REQUIRED" }, { status: 409 });
  }

  try {
    const updated = await applyFabricationAction(jobId, parsed.data.action, { id: user.id, name: machinist });
    return NextResponse.json({ updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update finishing job" }, { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
