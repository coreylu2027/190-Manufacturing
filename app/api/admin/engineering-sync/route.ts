import { NextResponse } from "next/server";

import { getAdminActor } from "@/lib/auth";
import { listEngineeringSyncProposals } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";

export const dynamic = "force-dynamic";

/** Recent staged Onshape syncs, newest first, without their payloads. */
export async function GET() {
  const user = await getAdminActor();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved || user.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });
  try {
    return NextResponse.json({ proposals: await listEngineeringSyncProposals() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load Onshape syncs" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
