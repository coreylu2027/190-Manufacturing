export const CAM_REQUIRED_MACHINES = ["Haas CNC", "Shop Sabre CNC"] as const;
export const POST_QC_MACHINES = ["Threaded Insert"] as const;

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
  operationKey?: string;
  operationNumber: string;
  machine: string;
  workType: OperationWorkType;
  status: WorkflowOperationStatus;
  active: boolean;
  claimedQuantity?: number;
  completedQuantity?: number;
  startedAt?: string | null;
  completedAt?: string | null;
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

export interface WorkflowContext {
  qcPassed: boolean;
  finishingRequired: boolean;
  finishingComplete: boolean;
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

const STATUS_PRIORITY: Record<WorkflowOperationStatus, number> = {
  Planned: 0,
  Ready: 1,
  Blocked: 2,
  "In Progress": 3,
  Complete: 4,
  "Needs Rework": 5,
};

type CanonicalOperation = Pick<WorkflowOperation, "id" | "operationKey" | "workType" | "status">
  & Partial<Pick<WorkflowOperation, "claimedQuantity" | "completedQuantity" | "startedAt" | "completedAt">>;

function canonicalOperationScore(operation: CanonicalOperation) {
  return [
    operation.completedQuantity ?? 0,
    operation.claimedQuantity ?? 0,
    operation.completedAt ? 1 : 0,
    operation.startedAt ? 1 : 0,
    STATUS_PRIORITY[operation.status],
  ] as const;
}

function preferCanonicalOperation<T extends CanonicalOperation>(left: T, right: T) {
  const leftScore = canonicalOperationScore(left);
  const rightScore = canonicalOperationScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) return leftScore[index] > rightScore[index] ? left : right;
  }
  return left.id <= right.id ? left : right;
}

/**
 * Collapses accidental copies of the same deterministic operation row. Rows at
 * the same route stage remain independent when their operation keys differ.
 */
export function deduplicateOperations<T extends CanonicalOperation>(operations: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const operation of operations) {
    const key = operation.operationKey
      ? `${operation.workType}|${operation.operationKey}`
      : `${operation.workType}|row:${operation.id}`;
    const current = unique.get(key);
    unique.set(key, current ? preferCanonicalOperation(current, operation) : operation);
  }
  return [...unique.values()];
}

export function requiresCam(machine: string) {
  return (CAM_REQUIRED_MACHINES as readonly string[]).includes(machine);
}

export function requiresPassedQc(machine: string) {
  return (POST_QC_MACHINES as readonly string[]).some((name) => name.toLocaleLowerCase() === machine.trim().toLocaleLowerCase());
}

export function validateCamAction(input: {
  action: "claim" | "release" | "complete" | "undo_complete";
  quantity: number;
  targetStarted?: boolean;
}) {
  if (input.quantity !== 1) throw new Error("CAM is a single task");
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
  context?: WorkflowContext,
): WorkflowPlan {
  const active = deduplicateOperations(operations.filter((operation) => operation.active));
  const manufacturing = active
    .filter((operation) => operation.workType === "Manufacturing")
    .sort((a, b) => operationIndex(a.operationNumber) - operationIndex(b.operationNumber));
  const preQcManufacturing = manufacturing.filter((operation) => !requiresPassedQc(operation.machine));
  const postQcManufacturing = manufacturing.filter((operation) => requiresPassedQc(operation.machine));
  const camTasks = active.filter((operation) => operation.workType === "CAM");
  const operationPatches: WorkflowStatusPatch[] = [];
  const projectedStatuses = new Map(active.map((operation) => [operation.id, operation.status]));

  for (const cam of camTasks) {
    if (cam.status === "Planned") {
      projectedStatuses.set(cam.id, "Ready");
      operationPatches.push({ id: cam.id, status: "Ready" });
    }
  }

  function planPhase(phase: WorkflowOperation[], released: boolean) {
    const stages = new Map<number, WorkflowOperation[]>();
    for (const operation of phase) {
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
        const nextStatus: WorkflowOperationStatus = released && previousComplete && camComplete ? "Ready" : "Planned";

        if (nextStatus !== operation.status) {
          projectedStatuses.set(operation.id, nextStatus);
          operationPatches.push({ id: operation.id, status: nextStatus });
        }
      }
      previousStage = stage;
    }
  }

  if (context) {
    planPhase(preQcManufacturing, true);
    planPhase(postQcManufacturing, context.qcPassed && (!context.finishingRequired || context.finishingComplete));
  } else {
    planPhase(manufacturing, true);
  }

  if (context) {
    if (preQcManufacturing.length === 0 || !preQcManufacturing.some((operation) => operationIndex(operation.operationNumber) === 1)) {
      return { operationPatches, requirementStatus: "Needs Triage" };
    }
    if (preQcManufacturing.some((operation) => projectedStatuses.get(operation.id) === "Needs Rework")) {
      return { operationPatches, requirementStatus: "Needs Rework" };
    }
    if (!preQcManufacturing.every((operation) => projectedStatuses.get(operation.id) === "Complete")) {
      if (preQcManufacturing.some((operation) => projectedStatuses.get(operation.id) === "In Progress")) {
        return { operationPatches, requirementStatus: "On Machine" };
      }
      const preQcOperationNumbers = new Set(preQcManufacturing.map((operation) => operation.operationNumber));
      if (camTasks.some((operation) => preQcOperationNumbers.has(operation.operationNumber)
        && projectedStatuses.get(operation.id) !== "Complete")) {
        return { operationPatches, requirementStatus: "Ready for CAM" };
      }
      return { operationPatches, requirementStatus: "Ready for Manufacturing" };
    }
    if (!context.qcPassed) {
      return { operationPatches, requirementStatus: "Ready for QC" };
    }
    if (context.finishingRequired && !context.finishingComplete) {
      return { operationPatches, requirementStatus: "Ready for Finishing" };
    }
    if (postQcManufacturing.some((operation) => projectedStatuses.get(operation.id) === "Needs Rework")) {
      return { operationPatches, requirementStatus: "Needs Rework" };
    }
    if (postQcManufacturing.some((operation) => projectedStatuses.get(operation.id) === "In Progress")) {
      return { operationPatches, requirementStatus: "On Machine" };
    }
    if (postQcManufacturing.length > 0
      && !postQcManufacturing.every((operation) => projectedStatuses.get(operation.id) === "Complete")) {
      return { operationPatches, requirementStatus: "Ready for Manufacturing" };
    }
    return { operationPatches, requirementStatus: "Complete" };
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
