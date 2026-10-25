import { after, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, parseId, readJson, requireUser } from "@/lib/api-route";
import { setRequirementObsolete } from "@/lib/manufacturing";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";
import { deliverObsoletionEmails } from "@/lib/notifications";

const schema = z.object({ obsolete: z.boolean(), expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await requireUser();
  if (response) return response;
  const parsed = await readJson(request, schema);
  if (!parsed.success) return NextResponse.json({ error: "Provide obsolete and expectedVersion" }, { status: 400 });
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });
  try {
    const { notificationContext, ...result } = await setRequirementObsolete(id, parsed.data.obsolete, parsed.data.expectedVersion, user);
    const { previousObsolete, ...partContext } = notificationContext;
    if (previousObsolete !== result.obsolete) {
      if (result.obsolete) after(async () => {
        try { await deliverObsoletionEmails(id, result.obsoletionVersion); }
        catch (error) { console.error("Obsoletion notification delivery failed", error); }
      });
      scheduleSlackManufacturingEvent({
        ...partContext,
        type: result.obsolete ? "requirement_obsoleted" : "requirement_restored",
        actorName: user.name,
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "Unable to change obsoletion");
  }
}
