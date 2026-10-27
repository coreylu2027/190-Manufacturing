import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson, requireUser } from "@/lib/api-route";
import { toBulkOutcomes } from "@/lib/bulk-selection";
import { forceQualityReviews } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { bulkForceQcNotes, FORCE_QC_NOTES_LIMIT } from "@/lib/quality-control";
import { scheduleQualityReviewEvent } from "@/lib/slack-notifications";

// Each Force QC review commits separately.
export const maxDuration = 120;

const bulkSchema = z.object({
  requirementIds: z.array(z.number().int().positive()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "Each production requirement can only be included once"),
  notes: z.string().trim().max(1500),
  result: z.enum(["passed", "failed"]),
  completeFinishing: z.boolean().default(false),
}).strict().refine((value) => !value.completeFinishing || value.result === "passed", { message: "Finishing can only be completed when QC passes" });

/** Force QC for many production requirements; returns one outcome per requirement, in order. */
export async function POST(request: Request) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return response;

  const parsed = await readJson(request, bulkSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  const { requirementIds, notes, result, completeFinishing } = parsed.data;

  try {
    const results = await forceQualityReviews(requirementIds, (preview) => {
      const combined = bulkForceQcNotes(preview.generatedNotes, notes, completeFinishing && preview.nextDestination === "Finishing");
      if (combined.length > FORCE_QC_NOTES_LIMIT) throw new ManufacturingWriteError(`Inspection notes exceed ${FORCE_QC_NOTES_LIMIT} characters`, 400);
      return combined;
    }, user, result, completeFinishing);
    return NextResponse.json({ results: toBulkOutcomes(results, "Unable to force QC", ({ notificationContext, ...review }) => {
      scheduleQualityReviewEvent(user.name, { result, notes: review.notes, storageLocation: null, rejectedQuantity: review.rejectedQuantity, forced: true }, notificationContext);
      return review;
    }) });
  } catch (error) {
    return errorResponse(error, "Unable to force QC");
  }
}
