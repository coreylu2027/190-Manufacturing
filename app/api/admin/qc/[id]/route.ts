import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminActor } from "@/lib/auth";
import { clearPassedQualityOutcome, getOperations, patchOperation, patchQualityOutcome } from "@/lib/baserow";
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
  const operationId = Number(id);
  if (!Number.isInteger(operationId)) return NextResponse.json({ error: "Invalid operation ID" }, { status: 400 });

  try {
    const operationData = await getOperations();
    const operation = operationData.operations.find((item) => item.id === operationId);
    if (!operation) return NextResponse.json({ error: "Operation not found" }, { status: 404 });
    if (operation.status !== "Complete") return NextResponse.json({ error: "Only completed operations can be reviewed" }, { status: 409 });

    const admin = createAdminClient();
    if (admin) {
      const timestamp = new Date().toISOString();
      const { error } = await admin.from("quality_control").upsert({
        operation_id: operationId,
        result: parsed.data.result,
        notes: parsed.data.notes,
        reviewed_by: currentUser.id,
        reviewed_at: timestamp,
        updated_at: timestamp,
      }, { onConflict: "operation_id" });
      if (error) throw error;
    }

    if (parsed.data.result === "failed") {
      await patchOperation(operationId, { status: "Needs Rework" }, currentUser.name);
    }
    await patchQualityOutcome(operationId, parsed.data.result);

    return NextResponse.json({ review: { operationId, ...parsed.data } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to record quality review" }, { status: 502 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const currentUser = await getAdminActor();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved || currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const { id } = await params;
  const operationId = Number(id);
  if (!Number.isInteger(operationId)) return NextResponse.json({ error: "Invalid operation ID" }, { status: 400 });

  try {
    const admin = createAdminClient();
    if (admin) {
      const { data: review, error: reviewError } = await admin.from("quality_control").select("result").eq("operation_id", operationId).maybeSingle();
      if (reviewError) throw reviewError;
      if (review?.result !== "passed") return NextResponse.json({ error: "Only a passed QC review can be undone directly" }, { status: 409 });
      const { error: deleteError } = await admin.from("quality_control").delete().eq("operation_id", operationId);
      if (deleteError) throw deleteError;
    }
    await clearPassedQualityOutcome(operationId);
    return NextResponse.json({ undone: true, operationId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to undo quality review" }, { status: 502 });
  }
}
