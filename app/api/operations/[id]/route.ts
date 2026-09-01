import { NextResponse } from "next/server";
import { z } from "zod";

import { getEffectiveAppUser, isAuthRequired } from "@/lib/auth";
import { patchOperation } from "@/lib/baserow";
import { OPERATION_STATUSES } from "@/lib/types";

const patchSchema = z.object({
  status: z.enum(OPERATION_STATUSES).optional(),
  machinist: z.string().trim().max(120).optional(),
}).refine((value) => value.status !== undefined || value.machinist !== undefined, "No changes supplied");

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getEffectiveAppUser();
  if (isAuthRequired() && !user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (isAuthRequired() && !user?.approved) {
    return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
  }

  const { id } = await params;
  const operationId = Number(id);
  if (!Number.isInteger(operationId)) return NextResponse.json({ error: "Invalid operation ID" }, { status: 400 });

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const machinist = user?.name ?? "Corey Lu";
  try {
    const updated = await patchOperation(operationId, parsed.data, machinist);
    return NextResponse.json({ updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update operation" }, { status: 502 });
  }
}
