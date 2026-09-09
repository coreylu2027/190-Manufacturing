import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminActor } from "@/lib/auth";
import { recordQualityReview, undoQualityReview, updatePassedQualityNotes } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";
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
  const currentUser = await getAdminActor();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved || currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const parsed = reviewSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { id } = await params;
  const requirementId = Number(id);
  if (!Number.isInteger(requirementId)) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    const location = parsed.data.result === "passed" ? parsed.data.location ?? null : null;
    const result = await recordQualityReview(
      requirementId,
      parsed.data.result,
      parsed.data.notes,
      currentUser,
      location,
      parsed.data.result === "failed" ? parsed.data.rejectedQuantity : undefined,
    );
    const { notificationContext, ...review } = result;
    scheduleSlackManufacturingEvent({
      type: "qc_reviewed",
      actorName: currentUser.name,
      result: parsed.data.result,
      notes: parsed.data.notes,
      storageLocation: location,
      rejectedQuantity: result.rejectedQuantity,
      becameReadyForFinishing: notificationContext.previousRequirementStatus !== "Ready for Finishing"
        && notificationContext.requirementStatus === "Ready for Finishing",
      postQcWorkReady: notificationContext.previousRequirementStatus !== "Ready for Manufacturing"
        && notificationContext.requirementStatus === "Ready for Manufacturing",
      becameComplete: notificationContext.previousRequirementStatus !== "Complete"
        && notificationContext.requirementStatus === "Complete",
      ...notificationContext,
    });
    return NextResponse.json({ review });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to record quality review" }, { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const currentUser = await getAdminActor();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved || currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const parsed = noteSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { id } = await params;
  const requirementId = Number(id);
  if (!Number.isInteger(requirementId)) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    const review = await updatePassedQualityNotes(requirementId, parsed.data.notes, currentUser);
    return NextResponse.json({ review });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update inspection notes" }, { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const currentUser = await getAdminActor();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved || currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const { id } = await params;
  const requirementId = Number(id);
  if (!Number.isInteger(requirementId)) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    const result = await undoQualityReview(requirementId, currentUser);
    const { notificationContext, ...review } = result;
    scheduleSlackManufacturingEvent({
      type: "qc_reopened",
      actorName: currentUser.name,
      ...notificationContext,
    });
    return NextResponse.json(review);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to undo quality review" }, { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
