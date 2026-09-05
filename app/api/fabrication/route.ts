import { NextResponse } from "next/server";

import { getEffectiveAppUser, isAuthRequired } from "@/lib/auth";
import { getFabricationJobs, getOperations } from "@/lib/baserow";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getEffectiveAppUser();
  if (isAuthRequired() && !user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (isAuthRequired() && !user?.approved) {
    return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
  }

  try {
    const data = await getFabricationJobs();
    if (data.source === "demo" || data.jobs.length === 0) {
      return NextResponse.json({ ...data, syncedAt: new Date().toISOString(), user });
    }

    const admin = createAdminClient();
    if (!admin) throw new Error("Supabase administration is not configured");

    const [{ data: reviews, error }, { data: legacyReviews, error: legacyError }] = await Promise.all([
      admin
        .from("quality_control")
        .select("production_requirement_id, notes, reviewed_at")
        .in("production_requirement_id", data.jobs.map((job) => job.requirementId)),
      admin
        .from("quality_control")
        .select("operation_id, notes, reviewed_at")
        .is("production_requirement_id", null)
        .not("operation_id", "is", null),
    ]);
    if (error) throw error;
    if (legacyError) throw legacyError;

    const latestNotesByRequirement = new Map<number, { notes: string; reviewedAt: string }>();
    const resolvedReviews = [...reviews];
    if (legacyReviews.length > 0) {
      const operationData = await getOperations();
      const requirementByOperation = new Map(operationData.operations.map((operation) => [operation.id, operation.requirementId]));
      resolvedReviews.push(...legacyReviews.flatMap((review) => {
        const requirementId = requirementByOperation.get(Number(review.operation_id));
        return requirementId ? [{ ...review, production_requirement_id: requirementId }] : [];
      }));
    }

    for (const review of resolvedReviews) {
      const requirementId = Number(review.production_requirement_id);
      if (!Number.isInteger(requirementId)) continue;
      const reviewedAt = String(review.reviewed_at);
      const current = latestNotesByRequirement.get(requirementId);
      if (!current || reviewedAt > current.reviewedAt) {
        latestNotesByRequirement.set(requirementId, { notes: String(review.notes ?? ""), reviewedAt });
      }
    }

    const jobs = data.jobs.map((job) => ({
      ...job,
      qcNotes: latestNotesByRequirement.get(job.requirementId)?.notes ?? "",
    }));
    return NextResponse.json({ ...data, jobs, syncedAt: new Date().toISOString(), user });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load finishing jobs" },
      { status: 502 },
    );
  }
}
