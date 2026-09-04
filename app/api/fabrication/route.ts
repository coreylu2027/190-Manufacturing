import { NextResponse } from "next/server";

import { getEffectiveAppUser, isAuthRequired } from "@/lib/auth";
import { getFabricationJobs } from "@/lib/baserow";
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
    const { qualityOperationLinks, ...data } = await getFabricationJobs();
    if (data.source === "demo" || qualityOperationLinks.length === 0) {
      return NextResponse.json({ ...data, syncedAt: new Date().toISOString(), user });
    }

    const admin = createAdminClient();
    if (!admin) throw new Error("Supabase administration is not configured");

    const { data: reviews, error } = await admin
      .from("quality_control")
      .select("operation_id, notes, reviewed_at")
      .in("operation_id", qualityOperationLinks.map((link) => link.operationId));
    if (error) throw error;

    const requirementByOperation = new Map(qualityOperationLinks.map((link) => [link.operationId, link.requirementId]));
    const latestNotesByRequirement = new Map<number, { notes: string; reviewedAt: string }>();
    for (const review of reviews) {
      const requirementId = requirementByOperation.get(Number(review.operation_id));
      if (!requirementId) continue;
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
