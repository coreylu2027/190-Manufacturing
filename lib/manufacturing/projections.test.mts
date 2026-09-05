import test from "node:test";
import assert from "node:assert/strict";

import { projectFinishing, projectOperations } from "./projections.ts";

const requirement = {
  id: 2,
  Part: [{ id: 3, value: "P-1" }],
  "Required Quantity": 2,
  Status: { value: "Ready for Finishing" },
  "Drawing PDF": [{ url: "https://legacy-source.invalid/legacy.pdf", visible_name: "legacy.pdf" }],
  "STEP File": [{ url: "https://legacy-source.invalid/legacy.step", visible_name: "legacy.step" }],
};
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

  const [projectedRework] = projectOperations([operation], [{
    ...requirement,
    Finishing: { value: "Black" },
    "QC Outcome": { value: "Passed" },
    Status: { value: "Needs Rework" },
  }], [part]);
  assert.equal(projectedRework.finishingComplete, false);

  const [projectedFinishing] = projectFinishing([finishing], [{
    ...requirement,
    "Part Location": "Shelf 2",
    "Location Updated By": "Morgan M.",
    "Location Updated At": "2026-09-05T15:00:00Z",
  }]);
  assert.equal(projectedFinishing.storageLocation, "Shelf 2");
  assert.equal(projectedFinishing.locationUpdatedBy, "Morgan M.");
});
