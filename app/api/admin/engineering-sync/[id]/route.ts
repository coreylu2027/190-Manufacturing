import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, readJson, requireUser } from "@/lib/api-route";
import { buildSyncReview } from "@/lib/engineering-sync-review";
import { decideEngineeringSync, readEngineeringSyncReviewState } from "@/lib/manufacturing";

// Approval re-reads the review (up to 60 s) and then commits the whole engineering
// transaction (up to 120 s), as the sync itself does.
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  exclusions: z.array(z.string().min(1).max(600)).max(10_000),
  token: z.string().min(1).max(100),
  note: z.string().max(2000),
}).strict();

/** One staged sync, with its change list computed against current rows. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { response } = await requireUser({ admin: true });
  if (response) return response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid sync proposal ID" }, { status: 400 });
  try {
    const state = await readEngineeringSyncReviewState(id);
    if (!state) return NextResponse.json({ error: "This sync proposal no longer exists" }, { status: 404 });
    const decidable = state.proposal.status === "pending" || state.proposal.status === "failed";
    return NextResponse.json({
      proposal: state.proposal,
      stale: state.stale,
      review: decidable && state.payload ? buildSyncReview(state) : null,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error, "Unable to load the sync proposal");
  }
}

/** Approve (optionally skipping changes) or deny a staged sync. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid sync proposal ID" }, { status: 400 });
  const parsed = await readJson(request, decisionSchema);
  if (!parsed.success) return NextResponse.json({ error: "Provide decision, exclusions, token, and note" }, { status: 400 });
  const { decision, exclusions, token, note } = parsed.data;
  try {
    return NextResponse.json(await decideEngineeringSync(id, decision, [...new Set(exclusions)], token, note.trim(), user));
  } catch (error) {
    return errorResponse(error, "Unable to record the decision");
  }
}
