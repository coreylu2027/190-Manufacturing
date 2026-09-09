import { NextResponse } from "next/server";
import { z } from "zod";

import { getAppUser } from "@/lib/auth";
import { updateRequirementNotes } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";

const requestSchema = z.object({
  notes: z.string().trim().max(5000),
}).strict();

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { id } = await params;
  const requirementId = Number(id);
  if (!Number.isInteger(requirementId)) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    return NextResponse.json(await updateRequirementNotes(requirementId, parsed.data.notes, user));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update production notes" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 },
    );
  }
}
