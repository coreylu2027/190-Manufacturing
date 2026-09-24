import { NextResponse } from "next/server";

import { getAdminActor } from "@/lib/auth";
import { readEngineeringCorrections } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";

export const dynamic = "force-dynamic";

/** Every active correction to Onshape data, for the admin report. */
export async function GET() {
  const user = await getAdminActor();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved || user.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });
  try {
    return NextResponse.json({ corrections: await readEngineeringCorrections() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load corrections" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
