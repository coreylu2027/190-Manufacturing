import assert from "node:assert/strict";
import test from "node:test";

import { buildOperationFlow } from "./operation-flow.ts";
import type { FinishingStage, ManufacturingOperation } from "./types.ts";

function operation(overrides: Partial<ManufacturingOperation> & Pick<ManufacturingOperation, "id" | "operationNumber" | "machine">) {
  const { id, operationNumber, machine, ...rest } = overrides;
  return {
    id,
    requirementId: 10,
    operationKey: `operation-${overrides.id}`,
    partNumber: "190-001",
    revision: "A",
    partName: "Test part",
    assemblyNumber: "Assembly",
    finishing: "Black",
    finishingRequired: true,
    finishingComplete: false,
    requirementStatus: "Ready for Manufacturing",
    effectiveQcResult: "pending",
    operationNumber,
    workType: "Manufacturing",
    machine,
    status: "Planned",
    activeInRouting: true,
    ...rest,
  } as ManufacturingOperation;
}

const finishing: FinishingStage = {
  id: 50,
  requirementId: 10,
  status: "In Progress",
  finish: "Black",
};

test("builds the actual route with CAM, QC, finishing, and post-QC work", () => {
  const operations = [
    operation({ id: 1, operationNumber: "OP1", machine: "Haas CNC", workType: "CAM", status: "Complete" }),
    operation({ id: 2, operationNumber: "OP1", machine: "Haas CNC", status: "Complete" }),
    operation({ id: 3, operationNumber: "OP2", machine: "Lathe", status: "Complete" }),
    operation({ id: 4, operationNumber: "OP3", machine: "Mill", status: "Complete", effectiveQcResult: "passed" }),
    operation({ id: 5, operationNumber: "OP4", machine: "Threaded Insert", status: "Planned" }),
  ];

  const stages = buildOperationFlow(operations, [finishing]);
  assert.deepEqual(stages.flatMap((stage) => stage.nodes.map((node) => node.label)), [
    "CAM OP1", "OP1", "OP2", "OP3", "QC", "Finishing", "OP4",
  ]);
  assert.equal(stages.find((stage) => stage.key === "qc")?.nodes[0].status, "Complete");
  assert.equal(stages.find((stage) => stage.key === "finishing")?.nodes[0].status, "In Progress");
  assert.equal(stages.at(-1)?.nodes[0].description, "Threaded Insert");
});

test("marks QC ready when every pre-QC operation is complete", () => {
  const stages = buildOperationFlow([
    operation({ id: 1, operationNumber: "OP1", machine: "Lathe", status: "Complete", finishingRequired: false }),
  ]);

  assert.equal(stages.find((stage) => stage.key === "qc")?.nodes[0].status, "Ready");
  assert.equal(stages.some((stage) => stage.key === "finishing"), false);
});

test("keeps parallel operations together at the same route stage", () => {
  const stages = buildOperationFlow([
    operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw", finishingRequired: false }),
    operation({ id: 2, operationNumber: "OP2", machine: "Mill", finishingRequired: false }),
    operation({ id: 3, operationNumber: "OP2", machine: "Lathe", finishingRequired: false }),
  ]);

  const parallelStage = stages.find((stage) => stage.key === "manufacturing:OP2");
  assert.deepEqual(parallelStage?.nodes.map((node) => node.description), ["Mill", "Lathe"]);
});

test("preserves warning statuses on operation nodes", () => {
  const stages = buildOperationFlow([
    operation({ id: 1, operationNumber: "OP1", machine: "Mill", status: "Blocked", finishingRequired: false }),
    operation({ id: 2, operationNumber: "OP2", machine: "Lathe", status: "Needs Rework", finishingRequired: false }),
  ]);

  const operationStatuses = stages.flatMap((stage) => stage.nodes)
    .filter((node) => node.kind === "operation")
    .map((node) => node.status);
  assert.deepEqual(operationStatuses, ["Blocked", "Needs Rework"]);
});
