import { NextResponse } from "next/server";
import { z } from "zod";

import { getAppUser } from "@/lib/auth";
import { applyQuantityAction, patchOperation, stealOperationClaim, updateCamHandoff } from "@/lib/manufacturing";
import { createNotification } from "@/lib/notifications";
import { isShopName } from "@/lib/profile-name";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";
import { OPERATION_STATUSES } from "@/lib/types";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";

const patchSchema = z.object({
  status: z.enum(OPERATION_STATUSES).optional(),
  machinist: z.string().trim().max(120).optional(),
}).refine((value) => value.status !== undefined || value.machinist !== undefined, "No changes supplied");

const quantityActionSchema = z.object({
  action: z.enum(["claim", "release", "complete", "undo_complete"]),
  quantity: z.number().int().positive(),
  programPath: z.string().trim().max(1024).optional(),
  notes: z.string().trim().max(5000).optional(),
}).superRefine((value, context) => {
  if (value.action !== "complete" && (value.programPath !== undefined || value.notes !== undefined)) {
    context.addIssue({ code: "custom", message: "CAM handoff details are only accepted when completing work" });
  }
});

const stealActionSchema = z.object({
  action: z.literal("steal"),
  confirmed: z.literal(true),
});

const camHandoffSchema = z.object({
  action: z.literal("edit_cam_handoff"),
  completedBy: z.string().trim().min(1, "Enter who completed the CAM").max(120),
  programPath: z.string().trim().max(1024),
  notes: z.string().trim().max(5000),
});

const requestSchema = z.union([patchSchema, quantityActionSchema, stealActionSchema, camHandoffSchema]);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAppUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!user.approved) {
    return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
  }

  const { id } = await params;
  const operationId = Number(id);
  if (!Number.isInteger(operationId)) return NextResponse.json({ error: "Invalid operation ID" }, { status: 400 });

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const machinist = user.name;
  try {
    if ("action" in parsed.data && !isShopName(machinist)) {
      return NextResponse.json({ error: "Set your first name and last initial before claiming work", code: "PROFILE_NAME_REQUIRED" }, { status: 409 });
    }
    if ("action" in parsed.data && parsed.data.action === "steal") {
      const stolen = await stealOperationClaim(operationId, { id: user.id, name: machinist });
      const operationLabel = stolen.context.workType === "CAM"
        ? `CAM for ${stolen.context.operationNumber}`
        : stolen.context.operationNumber;
      const recipients = stolen.displaced.filter((claimant) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimant.userId));
      const deliveries = await Promise.all(recipients.map((claimant) => createNotification({
        recipientId: claimant.userId,
        type: "production_requirement_stolen",
        title: "Your production requirement was stolen",
        message: `${machinist} took over ${claimant.quantity} claimed ${claimant.quantity === 1 ? "work unit" : "work units"} for ${stolen.context.partNumber} — ${stolen.context.partName} (${operationLabel}). Completed work was not changed.`,
        emailSubject: `Claim taken over: ${stolen.context.partNumber} ${operationLabel}`,
        data: {
          operationId: stolen.context.operationId,
          partNumber: stolen.context.partNumber,
          partName: stolen.context.partName,
          operationNumber: stolen.context.operationNumber,
          workType: stolen.context.workType,
          quantity: claimant.quantity,
          stolenByUserId: user.id,
          stolenByName: machinist,
        },
      })));
      scheduleSlackManufacturingEvent({
        type: "operation_claimed",
        actorName: machinist,
        requirementId: stolen.context.requirementId,
        partNumber: stolen.context.partNumber,
        partName: stolen.context.partName,
        assemblyNumber: stolen.context.assemblyNumber,
        operationNumber: stolen.context.operationNumber,
        workType: stolen.context.workType,
        machine: stolen.context.machine,
        quantity: stolen.context.quantity,
        tookOver: true,
      });
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
    if ("action" in parsed.data && parsed.data.action === "edit_cam_handoff") {
      if (user?.role !== "admin") {
        return NextResponse.json({ error: "Administrator access required" }, { status: 403 });
      }
      const result = await updateCamHandoff(operationId, parsed.data, user);
      const { notificationContext, ...updated } = result;
      const changedFields = [
        notificationContext.previousCompletedBy !== parsed.data.completedBy ? "completed by" : "",
        notificationContext.previousProgramPath !== parsed.data.programPath ? "program path" : "",
        notificationContext.previousNotes !== parsed.data.notes ? "notes" : "",
      ].filter(Boolean);
      if (changedFields.length > 0) {
        scheduleSlackManufacturingEvent({
          type: "cam_handoff_edited",
          actorName: user.name,
          requirementId: notificationContext.requirementId,
          partNumber: notificationContext.partNumber,
          partName: notificationContext.partName,
          assemblyNumber: notificationContext.assemblyNumber,
          operationNumber: notificationContext.operationNumber,
          machine: notificationContext.machine,
          changedFields,
        });
      }
      return NextResponse.json({ updated });
    }

    if (!("action" in parsed.data) && user.role !== "admin") {
      return NextResponse.json({ error: "Administrator access required for status overrides" }, { status: 403 });
    }
    if ("action" in parsed.data) {
      const result = await applyQuantityAction(operationId, parsed.data.action, parsed.data.quantity, {
          id: user.id,
          name: machinist,
        }, {
          programPath: parsed.data.programPath,
          notes: parsed.data.notes,
        });
      const { notificationContext, ...updated } = result;
      const eventType = {
        claim: "operation_claimed",
        complete: "operation_completed",
        release: "operation_released",
        undo_complete: "operation_reopened",
      } as const;
      scheduleSlackManufacturingEvent({
        type: eventType[parsed.data.action],
        actorName: machinist,
        requirementId: notificationContext.requirementId,
        partNumber: notificationContext.partNumber,
        partName: notificationContext.partName,
        assemblyNumber: notificationContext.assemblyNumber,
        operationNumber: notificationContext.operationNumber,
        workType: notificationContext.workType,
        machine: notificationContext.machine,
        quantity: parsed.data.quantity,
        becameReadyForQc: notificationContext.previousRequirementStatus !== "Ready for QC"
          && notificationContext.requirementStatus === "Ready for QC",
        becameComplete: notificationContext.previousRequirementStatus !== "Complete"
          && notificationContext.requirementStatus === "Complete",
      });
      return NextResponse.json({ updated });
    }

    const result = await patchOperation(operationId, parsed.data, user);
    const { notificationContext, ...updated } = result;
    const changes = [
      parsed.data.status !== undefined && parsed.data.status !== notificationContext.previousOperationStatus
        ? `status ${notificationContext.previousOperationStatus} → ${parsed.data.status}` : "",
      parsed.data.machinist !== undefined && parsed.data.machinist !== notificationContext.previousMachinist
        ? `machinist ${notificationContext.previousMachinist || "Unassigned"} → ${parsed.data.machinist || "Unassigned"}` : "",
    ].filter(Boolean);
    if (changes.length > 0) {
      scheduleSlackManufacturingEvent({
        type: "admin_override",
        actorName: user.name,
        requirementId: notificationContext.requirementId,
        partNumber: notificationContext.partNumber,
        partName: notificationContext.partName,
        assemblyNumber: notificationContext.assemblyNumber,
        operationNumber: notificationContext.operationNumber,
        workType: notificationContext.workType,
        machine: notificationContext.machine,
        changes,
        becameReadyForQc: notificationContext.previousRequirementStatus !== "Ready for QC"
          && notificationContext.requirementStatus === "Ready for QC",
        becameComplete: notificationContext.previousRequirementStatus !== "Complete"
          && notificationContext.requirementStatus === "Complete",
      });
    }
    return NextResponse.json({ updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update operation";
    const status = error instanceof ManufacturingWriteError ? error.status : message.includes("cannot be reopened") ? 409
      : message.includes("single task") ? 400
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
