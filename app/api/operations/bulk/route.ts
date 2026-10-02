import { NextResponse } from "next/server";
import { z } from "zod";

import { getAppUser } from "@/lib/auth";
import { toBulkOutcomes } from "@/lib/bulk-selection";
import { applyQuantityActions } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { isShopName } from "@/lib/profile-name";
import { scheduleOperationQuantityEvent } from "@/lib/slack-notifications";
import { storageLocationSchema } from "@/lib/storage-locations";

// Targets that also move a part commit one at a time.
export const maxDuration = 120;

const bulkSchema = z.object({
  action: z.enum(["claim", "release", "complete"]),
  items: z.array(z.object({
    id: z.number().int().positive(),
    quantity: z.number().int().positive(),
    location: storageLocationSchema.optional(),
    completeAllClaims: z.boolean().optional(),
    programPath: z.string().trim().max(1024).optional(),
    notes: z.string().trim().max(5000).optional(),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length) {
    context.addIssue({ code: "custom", message: "Each operation can only be included once" });
  }
  for (const item of value.items) {
    if (item.location !== undefined && value.action === "release") {
      context.addIssue({ code: "custom", message: "Location is only accepted when claiming or completing work" });
    }
    if (item.completeAllClaims && value.action !== "complete") {
      context.addIssue({ code: "custom", message: "Shared print completion requires a completion action" });
    }
    if (value.action !== "complete" && (item.programPath !== undefined || item.notes !== undefined)) {
      context.addIssue({ code: "custom", message: "CAM handoff details are only accepted when completing work" });
    }
  }
});

/** Claims, releases, or completes many operations; returns one outcome per item, in order. */
export async function POST(request: Request) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
  if (!isShopName(user.name)) {
    return NextResponse.json({ error: "Set your first name and last initial before claiming work", code: "PROFILE_NAME_REQUIRED" }, { status: 409 });
  }

  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { action, items } = parsed.data;

  try {
    const results = await applyQuantityActions(action, items.map(({ id, quantity, ...handoff }) => ({ id, quantity, handoff })), { id: user.id, name: user.name });
    const outcomes = toBulkOutcomes(results.map((result, index) => {
      if (result.status === "rejected") return result;
      const { notificationContext, ...updated } = result.value;
      scheduleOperationQuantityEvent(action, user.name, items[index].quantity, notificationContext);
      return { status: "fulfilled" as const, value: updated };
    }), "Unable to update operation");
    return NextResponse.json({ results: outcomes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update operations" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
