import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminActor } from "@/lib/auth";
import { forceQualityReview, previewForceQuality } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";

const schema = z.object({ notes: z.string().trim().max(2000), token: z.string().min(1) }).strict();
type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context) {
  const actor = await getAdminActor();
  if (!actor) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!actor.approved || actor.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });
  try {
    if (request.method === "GET") return NextResponse.json(await previewForceQuality(id));
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
    return NextResponse.json(await forceQualityReview(id, parsed.data.notes, parsed.data.token, actor));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to force QC" }, { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
export const GET = handle;
export const POST = handle;
