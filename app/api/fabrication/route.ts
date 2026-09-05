import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { getFabricationJobs, getOperations } from "@/lib/manufacturing";
import { loadQualityMetadata } from "@/lib/quality-control-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAppUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!user.approved) {
    return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
  }

  try {
    const [data, operationData] = await Promise.all([getFabricationJobs(), getOperations()]);
    const quality = await loadQualityMetadata(operationData.operations);
    const jobs = data.jobs.map((job) => {
      const metadata = quality.get(job.requirementId);
      return {
        ...job,
        qcNotes: metadata?.notes ?? "",
        storageLocation: job.storageLocation,
        locationUpdatedBy: job.locationUpdatedBy,
        locationUpdatedAt: job.locationUpdatedAt,
        effectiveQcResult: metadata?.effectiveQcResult ?? "pending" as const,
      };
    });
    return NextResponse.json({ ...data, jobs, syncedAt: new Date().toISOString(), user });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load finishing jobs" },
      { status: 502 },
    );
  }
}
