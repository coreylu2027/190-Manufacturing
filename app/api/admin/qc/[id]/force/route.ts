import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, parseId, readJson, requireUser } from "@/lib/api-route";
import { forceQualityReview, previewForceQuality } from "@/lib/manufacturing";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";

const schema = z.object({
  notes: z.string().trim().max(2000),
  token: z.string().min(1),
  result: z.enum(["passed", "failed"]).default("passed"),
  completeFinishing: z.boolean().default(false),
}).strict().refine(value => !value.completeFinishing || value.result === "passed", { message: "Finishing can only be completed when QC passes" });
type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return response;
  const id = parseId((await context.params).id);
  if (id === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });
  try {
    if (request.method === "GET") return NextResponse.json(await previewForceQuality(id));
    const parsed = await readJson(request, schema);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
    const result = await forceQualityReview(id, parsed.data.notes, parsed.data.token, user, parsed.data.result, parsed.data.completeFinishing);
    const { notificationContext, ...review } = result;
    scheduleSlackManufacturingEvent({
      type: "qc_reviewed",
      actorName: user.name,
      result: parsed.data.result,
      notes: parsed.data.notes,
      storageLocation: null,
      rejectedQuantity: result.rejectedQuantity,
      forced: true,
      becameReadyForFinishing: notificationContext.previousRequirementStatus !== "Ready for Finishing"
        && notificationContext.requirementStatus === "Ready for Finishing",
      becameComplete: notificationContext.previousRequirementStatus !== "Complete"
        && notificationContext.requirementStatus === "Complete",
      ...notificationContext,
    });
    return NextResponse.json(review);
  } catch (error) {
    return errorResponse(error, "Unable to force QC");
  }
}
export const GET = handle;
export const POST = handle;
