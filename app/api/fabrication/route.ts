import { NextResponse } from "next/server";

import { getEffectiveAppUser, isAuthRequired } from "@/lib/auth";
import { getFabricationJobs } from "@/lib/baserow";

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
    const data = await getFabricationJobs();
    return NextResponse.json({ ...data, syncedAt: new Date().toISOString(), user });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load finishing jobs" },
      { status: 502 },
    );
  }
}
