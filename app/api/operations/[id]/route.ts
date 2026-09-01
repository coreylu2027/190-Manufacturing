import { NextResponse } from "next/server";
import { z } from "zod";

import { getEffectiveAppUser, isAuthRequired } from "@/lib/auth";
import { applyQuantityAction, patchOperation } from "@/lib/baserow";
import { isShopName } from "@/lib/profile-name";
import { OPERATION_STATUSES } from "@/lib/types";

const patchSchema = z.object({
  status: z.enum(OPERATION_STATUSES).optional(),
  machinist: z.string().trim().max(120).optional(),
}).refine((value) => value.status !== undefined || value.machinist !== undefined, "No changes supplied");

const quantityActionSchema = z.object({
  action: z.enum(["claim", "release", "complete", "undo_complete"]),
  quantity: z.number().int().positive(),
});

const requestSchema = z.union([patchSchema, quantityActionSchema]);

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

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const machinist = user?.name ?? "Demo Machinist";
  try {
    if ("action" in parsed.data && !isShopName(machinist)) {
      return NextResponse.json({ error: "Set your first name and last initial before claiming work", code: "PROFILE_NAME_REQUIRED" }, { status: 409 });
    }
    const updated = "action" in parsed.data
      ? await applyQuantityAction(operationId, parsed.data.action, parsed.data.quantity, {
          id: user?.id ?? "demo-admin",
          name: machinist,
        })
      : await patchOperation(operationId, parsed.data, machinist);
    return NextResponse.json({ updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update operation" }, { status: 502 });
  }
}
