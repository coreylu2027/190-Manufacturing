import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson, requireUser } from "@/lib/api-route";
import { BULK_REQUEST_SIZE, toBulkOutcomes } from "@/lib/bulk-selection";
import { passQualityReviews } from "@/lib/manufacturing";
import { scheduleQualityReviewEvent } from "@/lib/slack-notifications";

// Each QC review commits separately.
export const maxDuration = 120;

const bulkSchema = z.object({
  reviews: z.array(z.object({
    requirementId: z.number().int().positive(),
    notes: z.string().trim().max(2000).default(""),
  }).strict()).min(1).max(BULK_REQUEST_SIZE)
    .refine((reviews) => new Set(reviews.map((review) => review.requirementId)).size === reviews.length, "Each production requirement can only be included once"),
}).strict();

/** Passes QC for many production requirements; returns one outcome per review, in order. */
export async function POST(request: Request) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return response;

  const parsed = await readJson(request, bulkSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { reviews } = parsed.data;

  try {
    const results = await passQualityReviews(reviews, user);
    return NextResponse.json({ results: toBulkOutcomes(results, "Unable to record quality review", ({ notificationContext, ...review }, index) => {
      scheduleQualityReviewEvent(user.name, { result: "passed", notes: reviews[index].notes, storageLocation: null, rejectedQuantity: review.rejectedQuantity }, notificationContext);
      return review;
    }) });
  } catch (error) {
    return errorResponse(error, "Unable to record quality reviews");
  }
}
