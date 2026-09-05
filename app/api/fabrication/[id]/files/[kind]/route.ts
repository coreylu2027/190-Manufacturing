import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { getFabricationJobs } from "@/lib/manufacturing";
import { ManufacturingFileError, storedManufacturingFileResponse } from "@/lib/manufacturing/files";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });

  const { id, kind } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) return NextResponse.json({ error: "Invalid finishing job ID" }, { status: 400 });
  if (kind !== "drawing-pdf" && kind !== "step") return NextResponse.json({ error: "Invalid file type" }, { status: 400 });

  try {
    const { jobs } = await getFabricationJobs();
    const job = jobs.find((item) => item.id === jobId);
    if (!job) return NextResponse.json({ error: "Finishing job not found" }, { status: 404 });

    const fallbackName = kind === "drawing-pdf" ? `${job.partNumber}.pdf` : `${job.partNumber}.step`;
    return storedManufacturingFileResponse(job.requirementId, kind, fallbackName);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to open the file" }, {
      status: error instanceof ManufacturingFileError ? error.status : 502,
    });
  }
}
