import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getAppUser } from "@/lib/auth";
import { setRequirementObsolete } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";
import { deliverObsoletionEmails } from "@/lib/notifications";

const schema = z.object({ obsolete: z.boolean(), expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide obsolete and expectedVersion" }, { status: 400 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });
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
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to change obsoletion" },
      { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
