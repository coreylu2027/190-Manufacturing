import { NextResponse } from "next/server";

import { requireUser } from "@/lib/api-route";
import { getCurrentManufacturingSnapshot } from "@/lib/manufacturing/cache";

export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;

  try {
    const { version, snapshot } = await getCurrentManufacturingSnapshot();
    return NextResponse.json({
      jobs: snapshot.jobs.filter((job) => !job.hidden && !job.offTheShelf),
      dataVersion: version,
      syncedAt: new Date().toISOString(),
      user,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load finishing jobs" },
      { status: 502 },
    );
  }
}
