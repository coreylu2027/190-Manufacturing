import { NextResponse } from "next/server";
import { z } from "zod";

import { getAppUser } from "@/lib/auth";
import { toBulkOutcomes } from "@/lib/bulk-selection";
import { applyFabricationActions } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { isShopName } from "@/lib/profile-name";
import { scheduleFinishingEvent } from "@/lib/slack-notifications";

const bulkSchema = z.object({
  action: z.enum(["claim", "release", "complete"]),
  ids: z.array(z.number().int().positive()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "Each finishing job can only be included once"),
}).strict();

/** Claims, releases, or completes many finishing jobs in one transaction; returns one outcome per job, in order. */
export async function POST(request: Request) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
  if (!isShopName(user.name)) {
    return NextResponse.json({ error: "Set your first name and last initial before recording work", code: "PROFILE_NAME_REQUIRED" }, { status: 409 });
  }

  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { action, ids } = parsed.data;

  try {
    const results = await applyFabricationActions(action, ids, { id: user.id, name: user.name });
    const outcomes = toBulkOutcomes(results.map((result) => {
      if (result.status === "rejected") return result;
      const { notificationContext, ...updated } = result.value;
      scheduleFinishingEvent(action, user.name, notificationContext);
      return { status: "fulfilled" as const, value: updated };
    }), "Unable to update finishing job");
    return NextResponse.json({ results: outcomes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update finishing jobs" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
