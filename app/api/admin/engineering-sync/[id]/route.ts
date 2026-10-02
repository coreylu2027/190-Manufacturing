import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminActor } from "@/lib/auth";
import { buildSyncReview, SyncReviewError } from "@/lib/engineering-sync-review";
import { decideEngineeringSync, readEngineeringSyncReviewState } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";

export const dynamic = "force-dynamic";
// Approval commits the whole engineering transaction, as the sync itself does.
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  exclusions: z.array(z.string().min(1).max(600)).max(10_000),
  token: z.string().min(1).max(100),
  note: z.string().max(2000),
}).strict();

async function adminOrError() {
  const user = await getAdminActor();
  if (!user) return { error: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  if (!user.approved || user.role !== "admin") return { error: NextResponse.json({ error: "Administrator access required" }, { status: 403 }) };
  return { user };
}

function failure(error: unknown, fallback: string) {
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback },
    { status: error instanceof ManufacturingWriteError ? error.status : error instanceof SyncReviewError ? 409 : 502 });
}

/** One staged sync, with its change list computed against current rows. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await adminOrError();
  if (!user) return error;
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
  } catch (caught) {
    return failure(caught, "Unable to load the sync proposal");
  }
}

/** Approve (optionally skipping changes) or deny a staged sync. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await adminOrError();
  if (!user) return error;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid sync proposal ID" }, { status: 400 });
  const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide decision, exclusions, token, and note" }, { status: 400 });
  const { decision, exclusions, token, note } = parsed.data;
  try {
    return NextResponse.json(await decideEngineeringSync(id, decision, [...new Set(exclusions)], token, note.trim(), user));
  } catch (caught) {
    return failure(caught, "Unable to record the decision");
  }
}
