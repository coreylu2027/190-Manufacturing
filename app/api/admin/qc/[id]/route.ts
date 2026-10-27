import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, parseId, readJson, requireUser } from "@/lib/api-route";
import { recordQualityReview, undoQualityReview, updatePassedQualityNotes } from "@/lib/manufacturing";
import { scheduleQualityReviewEvent, scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";
import { storageLocationSchema } from "@/lib/storage-locations";

const reviewSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("passed"),
    notes: z.string().trim().max(2000).default(""),
    location: storageLocationSchema.nullable().optional(),
  }).strict(),
  z.object({
    result: z.literal("failed"),
    notes: z.string().trim().min(1, "Enter a reason for the QC failure").max(2000),
    rejectedQuantity: z.number().int().positive().optional(),
  }).strict(),
]);

const noteSchema = z.object({
  notes: z.string().trim().max(2000).default(""),
}).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return response;

  const parsed = await readJson(request, reviewSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const requirementId = parseId((await params).id);
  if (requirementId === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    const location = parsed.data.result === "passed" ? parsed.data.location ?? null : null;
    const result = await recordQualityReview(
      requirementId,
      parsed.data.result,
      parsed.data.notes,
      user,
      location,
      parsed.data.result === "failed" ? parsed.data.rejectedQuantity : undefined,
    );
    const { notificationContext, ...review } = result;
    scheduleQualityReviewEvent(user.name, {
      result: parsed.data.result,
      notes: parsed.data.notes,
      storageLocation: location,
      rejectedQuantity: result.rejectedQuantity,
    }, notificationContext);
    return NextResponse.json({ review });
  } catch (error) {
    return errorResponse(error, "Unable to record quality review");
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return response;

  const parsed = await readJson(request, noteSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const requirementId = parseId((await params).id);
  if (requirementId === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    const review = await updatePassedQualityNotes(requirementId, parsed.data.notes, user);
    return NextResponse.json({ review });
  } catch (error) {
    return errorResponse(error, "Unable to update inspection notes");
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return response;

  const requirementId = parseId((await params).id);
  if (requirementId === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    const result = await undoQualityReview(requirementId, user);
    const { notificationContext, ...review } = result;
    scheduleSlackManufacturingEvent({
      type: "qc_reopened",
      actorName: user.name,
      ...notificationContext,
    });
    return NextResponse.json(review);
  } catch (error) {
    return errorResponse(error, "Unable to undo quality review");
  }
}
