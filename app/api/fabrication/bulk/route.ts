import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson, requireUser } from "@/lib/api-route";
import { BULK_REQUEST_SIZE, toBulkOutcomes } from "@/lib/bulk-selection";
import { applyFabricationActions } from "@/lib/manufacturing";
import { isShopName } from "@/lib/profile-name";
import { scheduleFinishingEvent } from "@/lib/slack-notifications";

const bulkSchema = z.object({
  action: z.enum(["claim", "release", "complete"]),
  ids: z.array(z.number().int().positive()).min(1).max(BULK_REQUEST_SIZE)
    .refine((ids) => new Set(ids).size === ids.length, "Each finishing job can only be included once"),
}).strict();

/** Claims, releases, or completes many finishing jobs in one transaction; returns one outcome per job, in order. */
export async function POST(request: Request) {
  const { user, response } = await requireUser();
  if (response) return response;
  if (!isShopName(user.name)) {
    return NextResponse.json({ error: "Set your first name and last initial before recording work", code: "PROFILE_NAME_REQUIRED" }, { status: 409 });
  }

  const parsed = await readJson(request, bulkSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { action, ids } = parsed.data;

  try {
    const results = await applyFabricationActions(action, ids, { id: user.id, name: user.name });
    return NextResponse.json({ results: toBulkOutcomes(results, "Unable to update finishing job", ({ notificationContext, ...updated }) => {
      scheduleFinishingEvent(action, user.name, notificationContext);
      return updated;
    }) });
  } catch (error) {
    return errorResponse(error, "Unable to update finishing jobs");
  }
}
