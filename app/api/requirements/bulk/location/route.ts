import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson, requireUser } from "@/lib/api-route";
import { BULK_REQUEST_SIZE, toBulkOutcomes } from "@/lib/bulk-selection";
import { updatePartLocations } from "@/lib/manufacturing";
import { scheduleLocationChangedEvent } from "@/lib/slack-notifications";
import { storageLocationSchema } from "@/lib/storage-locations";

// Each part's move commits separately.
export const maxDuration = 120;

const bulkSchema = z.object({
  requirementIds: z.array(z.number().int().positive()).min(1).max(BULK_REQUEST_SIZE)
    .refine((ids) => new Set(ids).size === ids.length, "Each production requirement can only be included once"),
  location: storageLocationSchema.nullable(),
}).strict();

/** Moves many parts to one location; returns one outcome per requirement, in order. */
export async function POST(request: Request) {
  const { user, response } = await requireUser();
  if (response) return response;

  const parsed = await readJson(request, bulkSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { requirementIds, location } = parsed.data;

  try {
    const results = await updatePartLocations(requirementIds, location, user);
    return NextResponse.json({ results: toBulkOutcomes(results, "Unable to update the part location", ({ notificationContext, ...updated }) => {
      scheduleLocationChangedEvent(user.name, location, notificationContext);
      return updated;
    }) });
  } catch (error) {
    return errorResponse(error, "Unable to update part locations");
  }
}
