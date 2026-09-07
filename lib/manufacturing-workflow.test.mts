import assert from "node:assert/strict";
import test from "node:test";

import {
  deduplicateOperations,
  planRequirementWorkflow,
  targetMachineHasStarted,
  validateCamAction,
  type WorkflowOperation,
} from "./manufacturing-workflow.ts";

function operation(overrides: Partial<WorkflowOperation> & Pick<WorkflowOperation, "id" | "operationNumber" | "machine">): WorkflowOperation {
  return {
    workType: "Manufacturing",
    status: "Planned",
    active: true,
    ...overrides,
  };
}

test("a non-CNC route becomes ready for manufacturing", () => {
  const plan = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw" }),
  ]);
  assert.deepEqual(plan.operationPatches, [{ id: 1, status: "Ready" }]);
  assert.equal(plan.requirementStatus, "Ready for Manufacturing");
});

test("CAM for OP1 blocks only its target", () => {
  const plan = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP1", machine: "Haas CNC", status: "Ready" }),
    operation({ id: 2, operationNumber: "OP1", machine: "Haas CNC", workType: "CAM", status: "Ready" }),
  ]);
  assert.deepEqual(plan.operationPatches, [{ id: 1, status: "Planned" }]);
  assert.equal(plan.requirementStatus, "Ready for CAM");
});

test("earlier manufacturing and later CAM can be ready together", () => {
  const plan = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw" }),
    operation({ id: 2, operationNumber: "OP2", machine: "Haas CNC" }),
    operation({ id: 3, operationNumber: "OP2", machine: "Haas CNC", workType: "CAM", status: "Ready" }),
  ]);
  assert.deepEqual(plan.operationPatches, [{ id: 1, status: "Ready" }]);
  assert.equal(plan.requirementStatus, "Ready for CAM");
});

test("target unlocks only after both physical and CAM prerequisites finish", () => {
  const waitingOnPhysical = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw", status: "Ready" }),
    operation({ id: 2, operationNumber: "OP2", machine: "Haas CNC" }),
    operation({ id: 3, operationNumber: "OP2", machine: "Haas CNC", workType: "CAM", status: "Complete" }),
  ]);
  assert.deepEqual(waitingOnPhysical.operationPatches, []);

  const ready = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw", status: "Complete" }),
    operation({ id: 2, operationNumber: "OP2", machine: "Haas CNC" }),
    operation({ id: 3, operationNumber: "OP2", machine: "Haas CNC", workType: "CAM", status: "Complete" }),
  ]);
  assert.deepEqual(ready.operationPatches, [{ id: 2, status: "Ready" }]);
  assert.equal(ready.requirementStatus, "Ready for Manufacturing");
});

test("multiple CNC operations keep independent CAM prerequisites", () => {
  const plan = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP1", machine: "Shop Sabre CNC" }),
    operation({ id: 2, operationNumber: "OP1", machine: "Shop Sabre CNC", workType: "CAM", status: "Complete" }),
    operation({ id: 3, operationNumber: "OP2", machine: "Haas CNC" }),
    operation({ id: 4, operationNumber: "OP2", machine: "Haas CNC", workType: "CAM", status: "Ready" }),
  ]);
  assert.deepEqual(plan.operationPatches, [{ id: 1, status: "Ready" }]);
  assert.equal(plan.requirementStatus, "Ready for CAM");
});

test("duplicate physical rows at the same operation number unlock in parallel", () => {
  const plan = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw" }),
    operation({ id: 2, operationNumber: "OP1", machine: "Bandsaw" }),
    operation({ id: 3, operationNumber: "OP2", machine: "Tapping" }),
  ]);
  assert.deepEqual(plan.operationPatches, [
    { id: 1, status: "Ready" },
    { id: 2, status: "Ready" },
  ]);
});

test("exact duplicate operation keys collapse to one canonical task", () => {
  const duplicate = operation({ id: 2, operationNumber: "OP1", machine: "Bandsaw", operationKey: "part|OP1" });
  const original = operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw", operationKey: "part|OP1" });
  assert.deepEqual(deduplicateOperations([duplicate, original]).map(({ id }) => id), [1]);

  const plan = planRequirementWorkflow([duplicate, original]);
  assert.deepEqual(plan.operationPatches, [{ id: 1, status: "Ready" }]);
});

test("canonical duplicate selection preserves the row with recorded work", () => {
  const original = operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw", operationKey: "part|OP1" });
  const worked = operation({
    id: 2,
    operationNumber: "OP1",
    machine: "Bandsaw",
    operationKey: "part|OP1",
    status: "In Progress",
    claimedQuantity: 1,
    startedAt: "2026-09-03T12:00:00.000Z",
  });
  assert.deepEqual(deduplicateOperations([original, worked]).map(({ id }) => id), [2]);
});

test("a route without OP1 remains in triage", () => {
  const plan = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP2", machine: "Haas CNC" }),
    operation({ id: 2, operationNumber: "OP2", machine: "Haas CNC", workType: "CAM", status: "Ready" }),
  ]);
  assert.equal(plan.requirementStatus, "Needs Triage");
});

test("physical work in progress takes status precedence over outstanding CAM", () => {
  const plan = planRequirementWorkflow([
    operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw", status: "In Progress" }),
    operation({ id: 2, operationNumber: "OP2", machine: "Haas CNC" }),
    operation({ id: 3, operationNumber: "OP2", machine: "Haas CNC", workType: "CAM", status: "Ready" }),
  ]);
  assert.equal(plan.requirementStatus, "On Machine");
});

test("completed manufacturing advances to QC while downstream lifecycle states are preserved", () => {
  const rows = [operation({ id: 1, operationNumber: "OP1", machine: "Bandsaw", status: "Complete" })];
  assert.equal(planRequirementWorkflow(rows).requirementStatus, "Ready for QC");
  assert.equal(planRequirementWorkflow(rows, "Ready for Finishing").requirementStatus, "Ready for Finishing");
  assert.equal(planRequirementWorkflow(rows, "Complete").requirementStatus, "Complete");
});

test("threaded inserts remain planned until QC and finishing release them", () => {
  const rows = [
    operation({ id: 1, operationNumber: "OP1", machine: "Mill", status: "Complete" }),
    operation({ id: 2, operationNumber: "OP2", machine: "Threaded Insert", status: "Planned" }),
  ];

  const awaitingQc = planRequirementWorkflow(rows, "Ready for Manufacturing", {
    qcPassed: false, finishingRequired: false, finishingComplete: true,
  });
  assert.equal(awaitingQc.requirementStatus, "Ready for QC");
  assert.deepEqual(awaitingQc.operationPatches, []);

  const awaitingFinishing = planRequirementWorkflow(rows, "Ready for Finishing", {
    qcPassed: true, finishingRequired: true, finishingComplete: false,
  });
  assert.equal(awaitingFinishing.requirementStatus, "Ready for Finishing");
  assert.deepEqual(awaitingFinishing.operationPatches, []);

  const released = planRequirementWorkflow(rows, "Ready for Manufacturing", {
    qcPassed: true, finishingRequired: true, finishingComplete: true,
  });
  assert.equal(released.requirementStatus, "Ready for Manufacturing");
  assert.deepEqual(released.operationPatches, [{ id: 2, status: "Ready" }]);

  const complete = planRequirementWorkflow([{ ...rows[0] }, { ...rows[1], status: "Complete" }], "On Machine", {
    qcPassed: true, finishingRequired: true, finishingComplete: true,
  });
  assert.equal(complete.requirementStatus, "Complete");
});

test("CAM actions require one task unit while the program path remains optional", () => {
  assert.throws(() => validateCamAction({ action: "claim", quantity: 2 }), /single task/);
  assert.doesNotThrow(() => validateCamAction({ action: "complete", quantity: 1 }));
});

test("CAM cannot be reopened after its target starts", () => {
  assert.throws(() => validateCamAction({ action: "undo_complete", quantity: 1, targetStarted: true }), /cannot be reopened/);
  assert.doesNotThrow(() => validateCamAction({ action: "undo_complete", quantity: 1, targetStarted: false }));
});

test("a released target with only a stale start timestamp does not block CAM reopening", () => {
  assert.equal(targetMachineHasStarted(operation({
    id: 1,
    operationNumber: "OP1",
    machine: "Haas CNC",
    status: "Ready",
    claimedQuantity: 0,
    completedQuantity: 0,
    startedAt: "2026-09-05T12:00:00.000Z",
  })), false);
});

test("active claims and partial completions still block CAM reopening", () => {
  assert.equal(targetMachineHasStarted(operation({
    id: 1,
    operationNumber: "OP1",
    machine: "Haas CNC",
    status: "In Progress",
    claimedQuantity: 1,
  })), true);
  assert.equal(targetMachineHasStarted(operation({
    id: 2,
    operationNumber: "OP1",
    machine: "Haas CNC",
    status: "Ready",
    completedQuantity: 1,
  })), true);
});
