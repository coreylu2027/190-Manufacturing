import { NextResponse } from "next/server";
import { z } from "zod";

import { getAppUser } from "@/lib/auth";
import { applyFabricationAction } from "@/lib/manufacturing";
import { isShopName } from "@/lib/profile-name";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { createAdminClient } from "@/lib/supabase/admin";
import { createNotification } from "@/lib/notifications";

const requestSchema = z.union([z.object({
  action: z.enum(["claim", "release", "complete", "undo_complete"]),
}), z.object({ action: z.literal("steal"), confirmed: z.literal(true) })]);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });

  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) return NextResponse.json({ error: "Invalid finishing job ID" }, { status: 400 });

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const machinist = user.name;
  if (!isShopName(machinist)) {
    return NextResponse.json({ error: "Set your first name and last initial before recording work", code: "PROFILE_NAME_REQUIRED" }, { status: 409 });
  }

  try {
    const result = await applyFabricationAction(jobId, parsed.data.action, { id: user.id, name: machinist });
    const { notificationContext, displacedMachinist, ...updated } = result;
    let notificationWarning: string | undefined;
    if (displacedMachinist) {
      // Finishing stores a shop name rather than an account ID. Only notify an
      // unambiguous exact match; never guess between people with the same name.
      try {
        const admin = createAdminClient();
        const match = displacedMachinist.replace(/[\\%_]/g, "\\$&");
        const profiles = admin ? await admin.from("profiles").select("id").ilike("display_name", match).limit(2) : null;
        if (profiles?.error || profiles?.data?.length !== 1 || profiles.data[0].id === user.id) {
          notificationWarning = "Finishing job taken over, but the previous machinist's account could not be identified for notification.";
        } else {
          const delivery = await createNotification({
            recipientId: profiles.data[0].id,
            type: "production_requirement_stolen",
            title: "Your finishing job was stolen",
            message: `${machinist} took over finishing for ${notificationContext.quantity} parts of ${notificationContext.partNumber} — ${notificationContext.partName}.`,
            emailSubject: `Claim taken over: ${notificationContext.partNumber} finishing`,
            data: { finishingId: jobId, requirementId: notificationContext.requirementId, partNumber: notificationContext.partNumber, stolenByUserId: user.id, stolenByName: machinist },
          });
          if (!delivery.stored || delivery.email === "failed") notificationWarning = "Finishing job taken over, but notification delivery was incomplete.";
        }
      } catch {
        notificationWarning = "Finishing job taken over, but notification delivery failed.";
      }
    }
    const eventType = {
      claim: "finishing_claimed",
      steal: "finishing_claimed",
      complete: "finishing_completed",
      release: "finishing_released",
      undo_complete: "finishing_reopened",
    } as const;
    scheduleSlackManufacturingEvent({
      type: eventType[parsed.data.action],
      actorName: machinist,
      requirementId: notificationContext.requirementId,
      partNumber: notificationContext.partNumber,
      partName: notificationContext.partName,
      assemblyNumber: notificationContext.assemblyNumber,
      color: notificationContext.color,
      quantity: notificationContext.quantity,
      postQcWorkReady: notificationContext.previousRequirementStatus !== "Ready for Manufacturing"
        && notificationContext.requirementStatus === "Ready for Manufacturing",
      becameComplete: notificationContext.previousRequirementStatus !== "Complete"
        && notificationContext.requirementStatus === "Complete",
    });
    return NextResponse.json({ updated, notificationWarning });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update finishing job" }, { status: error instanceof ManufacturingWriteError ? error.status : 502 });
  }
}
