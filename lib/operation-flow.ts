import { requiresPassedQc } from "./manufacturing-workflow.ts";
import type { FinishingStage, ManufacturingOperation, OperationStatus } from "./types.ts";

export type OperationFlowNode = {
  key: string;
  kind: "operation" | "qc" | "finishing";
  label: string;
  description: string;
  status: OperationStatus;
  operationId: number | null;
  finishingJobId: number | null;
  requirementId: number | null;
};

export type OperationFlowStage = {
  key: string;
  nodes: OperationFlowNode[];
};

function operationIndex(operationNumber: string) {
  const match = operationNumber.match(/^OP(\d+)$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function operationNode(operation: ManufacturingOperation): OperationFlowNode {
  return {
    key: `operation:${operation.id}`,
    kind: "operation",
    label: operation.workType === "CAM" ? `CAM ${operation.operationNumber}` : operation.operationNumber,
    description: operation.machine,
    status: operation.status,
    operationId: operation.id,
    finishingJobId: null,
    requirementId: operation.requirementId,
  };
}

function operationStages(
  manufacturing: ManufacturingOperation[],
  camTasks: ManufacturingOperation[],
): OperationFlowStage[] {
  const operationNumbers = [...new Set(manufacturing.map((operation) => operation.operationNumber))]
    .sort((left, right) => operationIndex(left) - operationIndex(right));

  return operationNumbers.flatMap((operationNumber) => {
    const camNodes = camTasks
      .filter((operation) => operation.operationNumber === operationNumber)
      .sort((left, right) => left.id - right.id)
      .map(operationNode);
    const manufacturingNodes = manufacturing
      .filter((operation) => operation.operationNumber === operationNumber)
      .sort((left, right) => left.id - right.id)
      .map(operationNode);

    return [
      ...(camNodes.length > 0 ? [{ key: `cam:${operationNumber}`, nodes: camNodes }] : []),
      { key: `manufacturing:${operationNumber}`, nodes: manufacturingNodes },
    ];
  });
}

function qcStatus(operations: ManufacturingOperation[]): OperationStatus {
  if (operations.some((operation) => operation.effectiveQcResult === "passed")) return "Complete";
  if (operations.some((operation) => operation.effectiveQcResult === "failed")) return "Needs Rework";

  const preQcManufacturing = operations.filter((operation) =>
    operation.workType === "Manufacturing" && !requiresPassedQc(operation.machine),
  );
  return preQcManufacturing.length > 0
    && preQcManufacturing.every((operation) => operation.status === "Complete")
    ? "Ready"
    : "Planned";
}

export function buildOperationFlow(
  operationsInput: readonly ManufacturingOperation[],
  finishingStages: readonly FinishingStage[] = [],
): OperationFlowStage[] {
  const operations = operationsInput.filter((operation) => operation.activeInRouting);
  if (operations.length === 0) return [];

  const manufacturing = operations.filter((operation) => operation.workType === "Manufacturing");
  const preQcManufacturing = manufacturing.filter((operation) => !requiresPassedQc(operation.machine));
  const postQcManufacturing = manufacturing.filter((operation) => requiresPassedQc(operation.machine));
  const camTasks = operations.filter((operation) => operation.workType === "CAM");
  const preQcNumbers = new Set(preQcManufacturing.map((operation) => operation.operationNumber));
  const postQcNumbers = new Set(postQcManufacturing.map((operation) => operation.operationNumber));
  const preQcCam = camTasks.filter((operation) => preQcNumbers.has(operation.operationNumber)
    || !postQcNumbers.has(operation.operationNumber));
  const postQcCam = camTasks.filter((operation) => postQcNumbers.has(operation.operationNumber)
    && !preQcNumbers.has(operation.operationNumber));
  const first = operations[0];
  const requirementId = first.requirementId;
  const finishing = requirementId === null
    ? undefined
    : finishingStages.find((stage) => stage.requirementId === requirementId);
  const stages: OperationFlowStage[] = [
    ...operationStages(preQcManufacturing, preQcCam),
    {
      key: "qc",
      nodes: [{
        key: "qc",
        kind: "qc",
        label: "QC",
        description: "Inspection",
        status: qcStatus(operations),
        operationId: null,
        finishingJobId: null,
        requirementId,
      }],
    },
  ];

  if (first.finishingRequired) {
    stages.push({
      key: "finishing",
      nodes: [{
        key: "finishing",
        kind: "finishing",
        label: "Finishing",
        description: finishing?.finish ?? first.finishing ?? "Specified finish",
        status: finishing?.status ?? (first.finishingComplete ? "Complete" : "Planned"),
        operationId: null,
        finishingJobId: finishing?.id ?? null,
        requirementId,
      }],
    });
  }

  stages.push(...operationStages(postQcManufacturing, postQcCam));
  return stages;
}
