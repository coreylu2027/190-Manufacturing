import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminActor } from "@/lib/auth";
import { toBulkOutcomes } from "@/lib/bulk-selection";
import { passQualityReviews } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { scheduleQualityReviewEvent } from "@/lib/slack-notifications";

// Each QC review commits separately.
export const maxDuration = 120;

const bulkSchema = z.object({
  reviews: z.array(z.object({
    requirementId: z.number().int().positive(),
    notes: z.string().trim().max(2000).default(""),
  }).strict()).min(1).max(100)
    .refine((reviews) => new Set(reviews.map((review) => review.requirementId)).size === reviews.length, "Each production requirement can only be included once"),
}).strict();

/** Passes QC for many production requirements; returns one outcome per review, in order. */
export async function POST(request: Request) {
  const currentUser = await getAdminActor();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved || currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { reviews } = parsed.data;

  try {
    const results = await passQualityReviews(reviews, currentUser);
    const outcomes = toBulkOutcomes(results.map((result, index) => {
      if (result.status === "rejected") return result;
      const { notificationContext, ...review } = result.value;
      scheduleQualityReviewEvent(currentUser.name, { result: "passed", notes: reviews[index].notes, storageLocation: null, rejectedQuantity: review.rejectedQuantity }, notificationContext);
      return { status: "fulfilled" as const, value: review };
    }), "Unable to record quality review");
    return NextResponse.json({ results: outcomes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to record quality reviews" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
