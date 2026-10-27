import { NextResponse } from "next/server";

import { errorResponse, requireUser } from "@/lib/api-route";
import { readEngineeringCorrections } from "@/lib/manufacturing";

/** Every active correction to Onshape data, for the admin report. */
export async function GET() {
  const { response } = await requireUser({ admin: true });
  if (response) return response;
  try {
    return NextResponse.json({ corrections: await readEngineeringCorrections() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to load corrections");
  }
}
