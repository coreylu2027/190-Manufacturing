import { NextResponse } from "next/server";
import { z } from "zod";

import { getEffectiveAppUser, isAuthRequired } from "@/lib/auth";
import { applyQuantityAction, patchOperation, stealOperationClaim } from "@/lib/baserow";
import { createNotification } from "@/lib/notifications";
import { isShopName } from "@/lib/profile-name";
import { OPERATION_STATUSES } from "@/lib/types";

const patchSchema = z.object({
  status: z.enum(OPERATION_STATUSES).optional(),
  machinist: z.string().trim().max(120).optional(),
}).refine((value) => value.status !== undefined || value.machinist !== undefined, "No changes supplied");

const quantityActionSchema = z.object({
  action: z.enum(["claim", "release", "complete", "undo_complete"]),
  quantity: z.number().int().positive(),
});

const stealActionSchema = z.object({
  action: z.literal("steal"),
  confirmed: z.literal(true),
});

const requestSchema = z.union([patchSchema, quantityActionSchema, stealActionSchema]);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getEffectiveAppUser();
  if (isAuthRequired() && !user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (isAuthRequired() && !user?.approved) {
    return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
  }

  const { id } = await params;
  const operationId = Number(id);
  if (!Number.isInteger(operationId)) return NextResponse.json({ error: "Invalid operation ID" }, { status: 400 });

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const machinist = user?.name ?? "Demo Machinist";
  try {
    if ("action" in parsed.data && !isShopName(machinist)) {
      return NextResponse.json({ error: "Set your first name and last initial before claiming work", code: "PROFILE_NAME_REQUIRED" }, { status: 409 });
    }
    if ("action" in parsed.data && parsed.data.action === "steal") {
      const stolen = await stealOperationClaim(operationId, { id: user?.id ?? "demo-admin", name: machinist });
      const recipients = stolen.displaced.filter((claimant) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimant.userId));
      const deliveries = await Promise.all(recipients.map((claimant) => createNotification({
        recipientId: claimant.userId,
        type: "production_requirement_stolen",
        title: "Your production requirement was stolen",
        message: `${machinist} took over ${claimant.quantity} claimed ${claimant.quantity === 1 ? "part" : "parts"} for ${stolen.context.partNumber} — ${stolen.context.partName} (${stolen.context.operationNumber}). Completed work was not changed.`,
        emailSubject: `Claim taken over: ${stolen.context.partNumber} ${stolen.context.operationNumber}`,
        data: {
          operationId: stolen.context.operationId,
          partNumber: stolen.context.partNumber,
          partName: stolen.context.partName,
          operationNumber: stolen.context.operationNumber,
          quantity: claimant.quantity,
          stolenByUserId: user?.id ?? "demo-admin",
          stolenByName: machinist,
        },
      })));
      return NextResponse.json({
        updated: stolen.updated,
        displaced: stolen.displaced,
        notificationDelivery: {
          alertsStored: deliveries.filter((delivery) => delivery.stored).length,
          emailsSent: deliveries.filter((delivery) => delivery.email === "sent").length,
          emailsFailed: deliveries.filter((delivery) => delivery.email === "failed").length,
          emailsSkipped: deliveries.filter((delivery) => delivery.email === "skipped").length,
          unmappedRecipients: stolen.displaced.length - recipients.length,
        },
      });
    }

    const updated = "action" in parsed.data
      ? await applyQuantityAction(operationId, parsed.data.action, parsed.data.quantity, {
          id: user?.id ?? "demo-admin",
          name: machinist,
        })
      : await patchOperation(operationId, parsed.data, machinist);
    return NextResponse.json({ updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update operation" }, { status: 502 });
  }
}
