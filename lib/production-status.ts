import { requiresPassedQc } from "./manufacturing-workflow.ts";
import type { ManufacturingOperation, OperationStatus } from "./types.ts";

export type ProductionStatus = OperationStatus | "QC Pending";

export function requirementStatus(operations: ManufacturingOperation[]): ProductionStatus {
  const inspectedOperations = operations.filter((operation) =>
    operation.workType === "Manufacturing" && !requiresPassedQc(operation.machine),
  );
  if (inspectedOperations.length > 0 && inspectedOperations.every((operation) =>
    operation.status === "Complete" && operation.effectiveQcResult === "pending",
  )) return "QC Pending";
  if (operations.every((operation) => operation.status === "Complete")) return "Complete";
  if (operations.some((operation) => operation.status === "Blocked")) return "Blocked";
  if (operations.some((operation) => operation.status === "In Progress")) return "In Progress";
  if (operations.some((operation) => operation.status === "Ready")) return "Ready";
  return "Planned";
}
