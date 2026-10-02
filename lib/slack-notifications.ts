import "server-only";

import { after } from "next/server";

import { postSlackManufacturingEvent, type SlackManufacturingEvent, type SlackPartContext } from "@/lib/slack-notifications-core";
import type { FabricationAction, OperationQuantityAction, OperationWorkType } from "@/lib/types";

export function scheduleSlackManufacturingEvent(event: SlackManufacturingEvent) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  after(async () => {
    const delivery = await postSlackManufacturingEvent(webhookUrl, event);
    if (delivery.status === "failed") {
      console.error(`[Slack notification] ${delivery.error ?? "Delivery failed"}`);
    }
  });
}

type StatusChange = { previousRequirementStatus: string; requirementStatus: string };

function partContext({ requirementId, partNumber, partName, assemblyNumber }: SlackPartContext): SlackPartContext {
  return { requirementId, partNumber, partName, assemblyNumber };
}

function became(context: StatusChange, status: string) {
  return context.previousRequirementStatus !== status && context.requirementStatus === status;
}

const OPERATION_EVENTS = {
  claim: "operation_claimed",
  complete: "operation_completed",
  release: "operation_released",
  undo_complete: "operation_reopened",
} as const;

export function scheduleOperationQuantityEvent(
  action: OperationQuantityAction,
  actorName: string,
  quantity: number,
  context: SlackPartContext & StatusChange & { operationNumber: string; workType: OperationWorkType; machine: string },
) {
  scheduleSlackManufacturingEvent({
    type: OPERATION_EVENTS[action],
    actorName,
    ...partContext(context),
    operationNumber: context.operationNumber,
    workType: context.workType,
    machine: context.machine,
    quantity,
    becameReadyForQc: became(context, "Ready for QC"),
    becameComplete: became(context, "Complete"),
  });
}

const FINISHING_EVENTS = {
  claim: "finishing_claimed",
  steal: "finishing_claimed",
  complete: "finishing_completed",
  release: "finishing_released",
  undo_complete: "finishing_reopened",
} as const;

export function scheduleFinishingEvent(
  action: FabricationAction,
  actorName: string,
  context: SlackPartContext & StatusChange & { color: string; quantity: number },
) {
  scheduleSlackManufacturingEvent({
    type: FINISHING_EVENTS[action],
    actorName,
    ...partContext(context),
    color: context.color,
    quantity: context.quantity,
    postQcWorkReady: became(context, "Ready for Manufacturing"),
    becameComplete: became(context, "Complete"),
  });
}

export function scheduleLocationChangedEvent(
  actorName: string,
  location: string | null,
  context: SlackPartContext & { previousLocation: string | null },
) {
  if (context.previousLocation === location) return;
  scheduleSlackManufacturingEvent({
    type: "location_changed",
    actorName,
    location,
    previousLocation: context.previousLocation,
    ...partContext(context),
  });
}

export function scheduleQualityReviewEvent(
  actorName: string,
  review: { result: "passed" | "failed"; notes: string; storageLocation: string | null; rejectedQuantity?: number | null; forced?: boolean },
  context: SlackPartContext & StatusChange,
) {
  scheduleSlackManufacturingEvent({
    type: "qc_reviewed",
    actorName,
    ...review,
    becameReadyForFinishing: became(context, "Ready for Finishing"),
    // Force QC only announces post-QC work on a pass; a failure also returns
    // the requirement to Ready for Manufacturing.
    postQcWorkReady: (!review.forced || review.result === "passed") && became(context, "Ready for Manufacturing"),
    becameComplete: became(context, "Complete"),
    ...context,
  });
}
