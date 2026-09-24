import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { readRequirementHistory } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { buildRequirementHistory } from "@/lib/requirement-history";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });

  const requirementId = Number((await params).id);
  if (!Number.isSafeInteger(requirementId) || requirementId <= 0) {
    return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });
  }

  try {
    const history = await readRequirementHistory(requirementId);
    if (!history) return NextResponse.json({ error: "Production requirement not found" }, { status: 404 });
    return NextResponse.json({ entries: buildRequirementHistory(history) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    // The adapter's server-failure messages describe writes; this is a read.
    if (error instanceof ManufacturingWriteError && error.status < 500) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Unable to load requirement history", error);
    return NextResponse.json({ error: "Unable to load history. Try again shortly." }, { status: 502 });
  }
}
