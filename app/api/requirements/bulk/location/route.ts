import { NextResponse } from "next/server";
import { z } from "zod";

import { getAppUser } from "@/lib/auth";
import { toBulkOutcomes } from "@/lib/bulk-selection";
import { updatePartLocations } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { scheduleLocationChangedEvent } from "@/lib/slack-notifications";
import { storageLocationSchema } from "@/lib/storage-locations";

// Each part's move commits separately.
export const maxDuration = 120;

const bulkSchema = z.object({
  requirementIds: z.array(z.number().int().positive()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "Each production requirement can only be included once"),
  location: storageLocationSchema.nullable(),
}).strict();

/** Moves many parts to one location; returns one outcome per requirement, in order. */
export async function POST(request: Request) {
  const currentUser = await getAppUser();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });

  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { requirementIds, location } = parsed.data;

  try {
    const results = await updatePartLocations(requirementIds, location, currentUser);
    const outcomes = toBulkOutcomes(results.map((result) => {
      if (result.status === "rejected") return result;
      const { notificationContext, ...updated } = result.value;
      scheduleLocationChangedEvent(currentUser.name, location, notificationContext);
      return { status: "fulfilled" as const, value: updated };
    }), "Unable to update the part location");
    return NextResponse.json({ results: outcomes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update part locations" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
