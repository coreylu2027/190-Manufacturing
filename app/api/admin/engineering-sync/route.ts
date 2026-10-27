import { NextResponse } from "next/server";

import { errorResponse, requireUser } from "@/lib/api-route";
import { listEngineeringSyncProposals } from "@/lib/manufacturing";

/** Recent staged Onshape syncs, newest first, without their payloads. */
export async function GET() {
  const { response } = await requireUser({ admin: true });
  if (response) return response;
  try {
    return NextResponse.json({ proposals: await listEngineeringSyncProposals() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to load Onshape syncs");
  }
}
