import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, parseId, readJson, requireUser } from "@/lib/api-route";
import { updateRequirementNotes } from "@/lib/manufacturing";

const requestSchema = z.object({
  notes: z.string().trim().max(5000),
}).strict();

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await requireUser();
  if (response) return response;

  const parsed = await readJson(request, requestSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const requirementId = parseId((await params).id);
  if (requirementId === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    return NextResponse.json(await updateRequirementNotes(requirementId, parsed.data.notes, user));
  } catch (error) {
    return errorResponse(error, "Unable to update production notes");
  }
}
