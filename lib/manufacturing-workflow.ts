export const CAM_REQUIRED_MACHINES = ["Haas CNC", "Shop Sabre CNC"] as const;

export type OperationWorkType = "Manufacturing" | "CAM";

export type WorkflowOperationStatus =
  | "Planned"
  | "Ready"
  | "In Progress"
  | "Blocked"
  | "Needs Rework"
  | "Complete";

export interface WorkflowOperation {
  id: number;
  operationNumber: string;
  machine: string;
  workType: OperationWorkType;
  status: WorkflowOperationStatus;
  active: boolean;
}

export interface WorkflowStatusPatch {
  id: number;
  status: WorkflowOperationStatus;
}

export interface WorkflowPlan {
  operationPatches: WorkflowStatusPatch[];
  requirementStatus:
    | "Needs Triage"
    | "Ready for CAM"
    | "Ready for Manufacturing"
    | "On Machine"
    | "Ready for QC"
    | "Needs Rework"
    | "Ready for Finishing"
    | "Complete";
}

const DOWNSTREAM_REQUIREMENT_STATUSES = new Set(["Ready for Finishing", "Complete"]);
const PRESERVED_OPERATION_STATUSES = new Set<WorkflowOperationStatus>([
  "In Progress",
  "Blocked",
  "Needs Rework",
  "Complete",
]);

function operationIndex(operationNumber: string) {
  const match = operationNumber.match(/^OP(\d+)$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function requiresCam(machine: string) {
  return (CAM_REQUIRED_MACHINES as readonly string[]).includes(machine);
}

export function validateCamAction(input: {
  action: "claim" | "release" | "complete" | "undo_complete";
  quantity: number;
  programPath?: string;
  targetStarted?: boolean;
}) {
  if (input.quantity !== 1) throw new Error("CAM is a single task");
  if (input.action === "complete" && !input.programPath?.trim()) {
    throw new Error("Enter the shared-drive program path before completing CAM");
  }
  if (input.action === "undo_complete" && input.targetStarted) {
    throw new Error("CAM cannot be reopened after the target machine operation has started");
  }
}

/**
 * Calculates operation readiness and the requirement summary without mutating
 * the supplied rows. CAM is paired to its target by operation number.
 */
export function planRequirementWorkflow(
  operations: readonly WorkflowOperation[],
  currentRequirementStatus = "Needs Triage",
): WorkflowPlan {
  const active = operations.filter((operation) => operation.active);
  const manufacturing = active
    .filter((operation) => operation.workType === "Manufacturing")
    .sort((a, b) => operationIndex(a.operationNumber) - operationIndex(b.operationNumber));
  const camTasks = active.filter((operation) => operation.workType === "CAM");
  const operationPatches: WorkflowStatusPatch[] = [];
  const projectedStatuses = new Map(active.map((operation) => [operation.id, operation.status]));

  for (const cam of camTasks) {
    if (cam.status === "Planned") {
      projectedStatuses.set(cam.id, "Ready");
      operationPatches.push({ id: cam.id, status: "Ready" });
    }
  }

  const stages = new Map<number, WorkflowOperation[]>();
  for (const operation of manufacturing) {
    const index = operationIndex(operation.operationNumber);
    stages.set(index, [...(stages.get(index) ?? []), operation]);
  }
  let previousStage: WorkflowOperation[] = [];
  for (const [, stage] of [...stages].sort(([left], [right]) => left - right)) {
    const previousComplete = previousStage.length === 0
      || previousStage.every((operation) => projectedStatuses.get(operation.id) === "Complete");
    for (const operation of stage) {
      if (PRESERVED_OPERATION_STATUSES.has(operation.status)) continue;

      const cam = camTasks.find((task) => task.operationNumber === operation.operationNumber);
      const camComplete = !requiresCam(operation.machine)
        || Boolean(cam && projectedStatuses.get(cam.id) === "Complete");
      const nextStatus: WorkflowOperationStatus = previousComplete && camComplete ? "Ready" : "Planned";

      if (nextStatus !== operation.status) {
        projectedStatuses.set(operation.id, nextStatus);
        operationPatches.push({ id: operation.id, status: nextStatus });
      }
    }
    previousStage = stage;
  }

  if (DOWNSTREAM_REQUIREMENT_STATUSES.has(currentRequirementStatus)) {
    return { operationPatches, requirementStatus: currentRequirementStatus as WorkflowPlan["requirementStatus"] };
  }
  if (manufacturing.length === 0 || !manufacturing.some((operation) => operationIndex(operation.operationNumber) === 1)) {
    return { operationPatches, requirementStatus: "Needs Triage" };
  }
  if (manufacturing.some((operation) => projectedStatuses.get(operation.id) === "Needs Rework")) {
    return { operationPatches, requirementStatus: "Needs Rework" };
  }
  if (manufacturing.every((operation) => projectedStatuses.get(operation.id) === "Complete")) {
    return { operationPatches, requirementStatus: "Ready for QC" };
  }
  if (manufacturing.some((operation) => projectedStatuses.get(operation.id) === "In Progress")) {
    return { operationPatches, requirementStatus: "On Machine" };
  }
  if (camTasks.some((operation) => projectedStatuses.get(operation.id) !== "Complete")) {
    return { operationPatches, requirementStatus: "Ready for CAM" };
  }
  return { operationPatches, requirementStatus: "Ready for Manufacturing" };
}
