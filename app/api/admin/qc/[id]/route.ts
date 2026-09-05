import { assertBaserowWriteSource, manufacturingConfig } from "@/lib/manufacturing/config";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminActor } from "@/lib/auth";
import { clearPassedRequirementQualityOutcome, getOperations, patchRequirementQualityOutcome, recordQualityReview, undoQualityReview } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { createAdminClient } from "@/lib/supabase/admin";

const reviewSchema = z.object({
  result: z.enum(["passed", "failed"]),
  notes: z.string().trim().max(2000).default(""),
});

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
    if (manufacturingConfig().write === "supabase") {
      const review = await recordQualityReview(requirementId, parsed.data.result, parsed.data.notes, currentUser);
      return NextResponse.json({ review });
    }
    assertBaserowWriteSource();
    const operationData = await getOperations();
    const operations = operationData.operations.filter((item) =>
      item.requirementId === requirementId && item.workType === "Manufacturing",
    );
    if (operations.length === 0) return NextResponse.json({ error: "Production requirement not found" }, { status: 404 });
    if (!operations.every((operation) => operation.status === "Complete")) {
      return NextResponse.json({ error: "All manufacturing operations must be complete before QC" }, { status: 409 });
    }

    const admin = createAdminClient();
    if (!admin) return NextResponse.json({ error: "Supabase administration is not configured" }, { status: 503 });
    const timestamp = new Date().toISOString();
    const { data: review, error } = await admin.from("quality_control").insert({
      production_requirement_id: requirementId,
      operation_id: null,
      result: parsed.data.result,
      notes: parsed.data.notes,
      reviewed_by: currentUser.id,
      reviewed_at: timestamp,
      updated_at: timestamp,
    }).select("id").single();
    if (error) throw error;

    try {
      await patchRequirementQualityOutcome(
        requirementId,
        parsed.data.result,
        currentUser.name,
        parsed.data.notes,
        timestamp,
      );
    } catch (error) {
      await admin.from("quality_control").delete().eq("id", review.id);
      throw error;
    }

    return NextResponse.json({ review: { requirementId, ...parsed.data } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to record quality review" }, { status: error instanceof ManufacturingWriteError ? error.status : 502 });
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
    if (manufacturingConfig().write === "supabase") {
      return NextResponse.json(await undoQualityReview(requirementId, currentUser));
    }
    assertBaserowWriteSource();
    const admin = createAdminClient();
    if (!admin) return NextResponse.json({ error: "Supabase administration is not configured" }, { status: 503 });
    const { data: review, error: reviewError } = await admin
      .from("quality_control")
      .select("id, result, notes, reviewed_at")
      .eq("production_requirement_id", requirementId)
      .order("reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (reviewError) throw reviewError;
    if (review?.result !== "passed") return NextResponse.json({ error: "Only a passed QC review can be undone directly" }, { status: 409 });

    await clearPassedRequirementQualityOutcome(requirementId);
    const { error: deleteError } = await admin.from("quality_control").delete().eq("id", review.id);
    if (deleteError) {
      await patchRequirementQualityOutcome(
        requirementId,
        "passed",
        currentUser.name,
        review.notes,
        review.reviewed_at,
      );
      throw deleteError;
    }
    return NextResponse.json({ undone: true, requirementId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to undo quality review" }, { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
