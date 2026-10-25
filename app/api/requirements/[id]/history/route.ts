import { NextResponse } from "next/server";

import { parseId, requireUser } from "@/lib/api-route";
import { readRequirementHistory } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { buildRequirementHistory } from "@/lib/requirement-history";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { response } = await requireUser();
  if (response) return response;

  const requirementId = parseId((await params).id);
  if (requirementId === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

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
