import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { getOperations } from "@/lib/manufacturing";
import { enrichOperationsWithQuality } from "@/lib/quality-control";
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
    const data = await getOperations();
    const quality = await loadQualityMetadata(data.operations);
    return NextResponse.json({
      ...data,
      operations: enrichOperationsWithQuality(data.operations, quality),
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
