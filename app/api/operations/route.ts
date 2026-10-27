import { NextResponse } from "next/server";

import { requireUser } from "@/lib/api-route";
import { getCurrentManufacturingSnapshot } from "@/lib/manufacturing/cache";

export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;

  try {
    const { version, snapshot } = await getCurrentManufacturingSnapshot();
    return NextResponse.json({
      operations: user.role === "admin" ? snapshot.operations : snapshot.operations.filter((operation) => !operation.hidden),
      cotsRequirements: user.role === "admin" ? snapshot.cotsRequirements : snapshot.cotsRequirements.filter((requirement) => !requirement.hidden),
      dataVersion: version,
      syncedAt: new Date().toISOString(),
      user,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load operations" },
      { status: 502 },
    );
  }
}
