import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, parseId, readJson, requireUser } from "@/lib/api-route";
import { setRequirementHidden } from "@/lib/manufacturing";

const schema = z.object({ hidden: z.boolean(), expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return response;
  const parsed = await readJson(request, schema);
  if (!parsed.success) return NextResponse.json({ error: "Provide hidden and expectedVersion" }, { status: 400 });
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });
  try {
    return NextResponse.json(await setRequirementHidden(id, parsed.data.hidden, parsed.data.expectedVersion, user));
  } catch (error) {
    return errorResponse(error, "Unable to change visibility");
  }
}
