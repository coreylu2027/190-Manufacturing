import test from "node:test";
import assert from "node:assert/strict";

import { projectFinishing, projectOperations, projectProduction } from "./projections.ts";

const requirement = {
  id: 2,
  Part: [{ id: 3, value: "P-1" }],
  "Required Quantity": 2,
  Status: { value: "Ready for Finishing" },
  "Drawing PDF": [{ url: "https://legacy-source.invalid/legacy.pdf", visible_name: "legacy.pdf" }],
  "STEP File": [{ url: "https://legacy-source.invalid/legacy.step", visible_name: "legacy.step" }],
};

test("hidden obsolete history retains visibility metadata for the admin archive", () => {
  const archived = { ...requirement, Obsolete: true, Hidden: true, "Visibility Version": 3, "Active in BOM": false };
  const [op] = projectOperations([{ ...operation, "Active in Routing": false }], [archived], [part]);
  assert.equal(op.hidden, true);
  assert.equal(op.visibilityVersion, 3);
  assert.equal(op.obsolete, true);
  const [job] = projectFinishing([{ ...finishing, Active: false }], [archived]);
  assert.equal(job.hidden, true);
  assert.equal(job.visibilityVersion, 3);
});
const operation = {
  id: 1,
  Operation: "root|part|OP1",
  "Production Requirement": [{ id: 2, value: "P-1 — Bracket [A-1]" }],
  "Operation Number": { value: "OP1" },
  "Work Type": { value: "Manufacturing" },
  Machine: { value: "Mill" },
  Status: { value: "Ready" },
  "Active in Routing": true,
};
const part = { id: 3, Material: "Aluminum" };
test("production stays pending until required powder coating completes, including post-finishing inserts", () => {
  const coatedRequirement = { ...requirement, Finishing: { value: "Black" }, "QC Outcome": { value: "Passed" } };
  const completedOperation = { ...operation, Status: { value: "Complete" } };
  const [pendingQc] = projectOperations([completedOperation], [coatedRequirement], [part]);
  assert.equal(projectProduction([pendingQc])[0].status, "QC Pending");
  const passed = { ...pendingQc, effectiveQcResult: "passed" as const };
  assert.equal(projectProduction([passed])[0].status, "Finishing Pending");
  assert.equal(projectProduction([{ ...passed, status: "In Progress" }])[0].status, "In Progress");
  const inserts = { ...passed, id: 5, machine: "Threaded Insert", status: "Planned" as const };
  assert.equal(projectProduction([passed, inserts])[0].status, "Finishing Pending");

  const finished = projectOperations([completedOperation], [{ ...coatedRequirement, Status: { value: "Complete" } }], [part])
    .map(row => ({ ...row, effectiveQcResult: "passed" as const }));
  assert.equal(projectProduction(finished)[0].status, "Complete");
  assert.equal(projectProduction([...finished, { ...inserts, finishingComplete: true, status: "Ready" }])[0].status, "Ready");
  assert.equal(projectProduction([{ ...passed, finishingRequired: false }])[0].status, "Complete");
});
const finishing = {
  id: 4,
  "Production Key": "root|part",
  "Production Requirement": [{ id: 2, value: "P-1 — Bracket [A-1]" }],
  Active: true,
};
const attachments = [
  { partId: 3, kind: "drawing-pdf" as const, position: 0, originalName: "P-1 REV B.pdf" },
  { partId: 3, kind: "step" as const, position: 0, originalName: "P-1 REV B.step" },
];

test("obsolete and restored historical requirements remain visible without resurrecting deactivated stages of active routes", () => {
  const historical = { ...requirement, Obsolete: true, "Obsoletion Version": 1, "Active in BOM": false,
    "Required Part Revision": "A", "Obsoletion Origin": "automatic", "Replacement Requirement": 99 };
  const done = { ...operation, "Active in Routing": false, Status: { value: "Complete" }, "Completed Quantity": 2 };
  const [projected] = projectOperations([done], [historical], [part]);
  assert.equal(projected.obsolete, true);
  assert.equal(projected.completedQuantity, 2);
  assert.equal(projected.revision, "A");
  assert.equal(projected.activeInRouting, false);
  assert.equal(projected.replacementRequirementId, 99);
  const [restored] = projectOperations([done], [{ ...historical, Obsolete: false, "Obsoletion Version": 2 }], [part]);
  assert.equal(restored.obsolete, false);
  assert.equal(restored.activeInRouting, false);
  assert.equal(restored.status, "Complete");
  assert.equal(projectFinishing([{ ...finishing, Active: false }], [historical])[0].obsolete, true);
  assert.equal(projectOperations([done], [requirement], [part]).length, 0);
  const active = { ...operation, id: 8, Operation: "new-route" };
  assert.deepEqual(projectOperations([done, active], [historical], [part]).map(row => row.id), [8]);
});

test("file availability and exact names come only from the Supabase attachment catalog", () => {
  const withoutCatalog = projectOperations([operation], [requirement], [part]);
  assert.equal(withoutCatalog[0].hasDrawingPdf, false);
  assert.equal(withoutCatalog[0].hasStepFile, false);
  assert.equal(withoutCatalog[0].drawingPdfName, null);

  const [projected] = projectOperations([operation], [requirement], [part], attachments);
  assert.equal(projected.hasDrawingPdf, true);
  assert.equal(projected.drawingPdfName, "P-1 REV B.pdf");
  assert.equal(projected.hasStepFile, true);
  assert.equal(projected.stepName, "P-1 REV B.step");

  const [job] = projectFinishing([finishing], [requirement], attachments);
  assert.equal(job.hasDrawingPdf, true);
  assert.equal(job.drawingPdfName, "P-1 REV B.pdf");
  assert.equal(job.hasStepFile, true);
  assert.equal(job.stepName, "P-1 REV B.step");
});

test("threaded inserts stay hidden behind QC and finishing while completed finishing remains visible", () => {
  const threadedInsert = {
    ...operation,
    id: 5,
    Operation: "root|part|OP2",
    "Operation Number": { value: "OP2" },
    Machine: { value: "Threaded Insert" },
    Status: { value: "Ready" },
  };
  const awaitingFinishing = {
    ...requirement,
    Finishing: { value: "Black" },
    "QC Outcome": { value: "Passed" },
    Status: { value: "Ready for Finishing" },
  };
  assert.equal(projectOperations([threadedInsert], [awaitingFinishing], [part])[0].status, "Planned");

  const finishingComplete = { ...awaitingFinishing, Status: { value: "Ready for Manufacturing" } };
  assert.equal(projectOperations([threadedInsert], [finishingComplete], [part])[0].status, "Ready");
  assert.equal(projectFinishing([finishing], [finishingComplete], [], [threadedInsert])[0].status, "Complete");
});

test("requirement projections include independent location and lifecycle details", () => {
  const [projected] = projectOperations([operation], [{
    ...requirement,
    "Production Key": "root|part",
    Configuration: "Main",
    "BOM Positions": "2, 5",
    Finishing: { value: "Black" },
    "QC Outcome": { value: "Passed" },
    Status: { value: "Ready for Manufacturing" },
    "Part Location": "Shelf 2",
    "Production Notes": "Deburr before inspection",
    "Location Updated By": "Morgan M.",
    "Location Updated At": "2026-09-05T15:00:00Z",
  }], [part]);

  assert.equal(projected.requirementKey, "root|part");
  assert.equal(projected.configuration, "Main");
  assert.equal(projected.bomPositions, "2, 5");
  assert.equal(projected.finishing, "Black");
  assert.equal(projected.finishingComplete, true);
  assert.equal(projected.storageLocation, "Shelf 2");
  assert.equal(projected.locationUpdatedBy, "Morgan M.");
  assert.equal(projected.productionNotes, "Deburr before inspection");

  const [projectedFinishing] = projectFinishing([finishing], [{
    ...requirement,
    "Part Location": "Shelf 2",
    "Production Notes": "Keep masking installed",
    "Location Updated By": "Morgan M.",
    "Location Updated At": "2026-09-05T15:00:00Z",
  }]);
  assert.equal(projectedFinishing.storageLocation, "Shelf 2");
  assert.equal(projectedFinishing.locationUpdatedBy, "Morgan M.");
  assert.equal(projectedFinishing.productionNotes, "Keep masking installed");
});

 test("production status identifies pending QC before completion and post-QC inserts", async () => {
  const { projectProduction } = await import("./projections.ts");
  const completed = projectOperations([{ ...operation, Status: { value: "Complete" } }], [requirement], [part]);
  assert.equal(projectProduction(completed)[0].status, "QC Pending");
  const inserts = { ...completed[0], id: 5, machine: "Threaded Insert", status: "Planned" as const };
  assert.equal(projectProduction([...completed, inserts])[0].status, "QC Pending");
  assert.equal(projectProduction(completed.map(row => ({ ...row, effectiveQcResult: "passed" as const })))[0].status, "Complete");
  assert.equal(projectProduction(completed.map(row => ({ ...row, status: "In Progress" as const })))[0].status, "In Progress");
  assert.equal(projectProduction(completed.map(row => ({ ...row, workType: "CAM" as const })))[0].status, "Complete");
  assert.notEqual(projectProduction(completed.map(row => ({ ...row, effectiveQcResult: "failed" as const })))[0].status, "QC Pending");
});

test("off-the-shelf requirements keep their retired routes visible with an Off the Shelf production status", () => {
  const bought = { ...requirement, "Off The Shelf": true, "Active in BOM": true };
  const [op] = projectOperations([{ ...operation, "Active in Routing": false }], [bought], [part]);
  assert.equal(op.offTheShelf, true);
  assert.equal(op.activeInRouting, false);
  assert.equal(projectProduction([op])[0].status, "Off the Shelf");
  assert.equal(projectOperations([{ ...operation, "Active in Routing": false }], [{ ...requirement, "Active in BOM": true }], [part]).length, 0);
});
