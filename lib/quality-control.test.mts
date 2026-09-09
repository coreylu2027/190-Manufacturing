import test from "node:test";
import assert from "node:assert/strict";

import { projectQualityControl, qualityMetadataByRequirement, type QualityReviewRow } from "./quality-control.ts";
import type { ManufacturingOperation } from "./types.ts";

function operation(completedAt = "2026-09-05T12:00:00Z"): ManufacturingOperation {
  return {
    id: 10, requirementId: 20, requirementKey: "fixture", operationKey: "fixture", partNumber: "P-1", revision: null,
    partName: "Fixture", assemblyNumber: "A-1", documentName: null, sourceRoot: null,
    sourceAssemblyRevision: null, requiredPartRevision: null, configuration: null,
    bomPositions: null, material: null, finishing: null, finishingRequired: false,
    finishingComplete: true, requirementStatus: "Ready for QC", requirementMachinist: "Alex A.",
    activeInBom: true, engineeringChanged: false, disposition: null, productionNotes: "Check the bore",
    qualityNotes: "",
    qualityReviewedBy: null, qualityReviewedAt: null,
    quantity: 1, taskQuantity: 1, claimedQuantity: 0, completedQuantity: 1,
    availableQuantity: 0, allocations: [], operationNumber: "OP1", workType: "Manufacturing",
    machine: "Mill", status: "Complete", machinist: "Alex A.", startedAt: null, completedAt,
    activeInRouting: true, camProgramPath: null, camNotes: "", camDependency: null,
    drawingUrl: null, hasDrawingPdf: false, drawingPdfName: null, hasStepFile: false,
    stepName: null, onshapeUrl: null, storageLocation: null, locationUpdatedBy: null,
    locationUpdatedAt: null, effectiveQcResult: "pending",
    lastQualityFailure: null,
  };
}

function review(overrides: Partial<QualityReviewRow> = {}): QualityReviewRow {
  return {
    id: 30, production_requirement_id: 20, operation_id: null, result: "passed", notes: "Good",
    rejected_quantity: null,
    reviewed_by: "reviewer", reviewed_at: "2026-09-05T13:00:00Z", storage_location: "Clarke 1",
    location_updated_by: "mover", location_updated_at: "2026-09-05T14:00:00Z", ...overrides,
  };
}

const profiles = [
  { id: "reviewer", display_name: "Robin R." },
  { id: "mover", display_name: "Morgan M." },
];

test("effective passed QC exposes location and update attribution", () => {
  const result = qualityMetadataByRequirement([operation()], [review()], [], profiles).metadata.get(20);
  assert.equal(result?.effectiveQcResult, "passed");
  assert.equal(result?.storageLocation, "Clarke 1");
  assert.equal(result?.locationUpdatedBy, "Morgan M.");
  assert.equal(result?.locationUpdatedAt, "2026-09-05T14:00:00Z");
});

test("missing, stale, and retracted reviews are pending and expose no location", () => {
  const missing = qualityMetadataByRequirement([operation()], [], [], profiles).metadata.get(20);
  const stale = qualityMetadataByRequirement([operation("2026-09-05T15:00:00Z")], [review()], [], profiles).metadata.get(20);
  const retracted = qualityMetadataByRequirement([operation()], [review()], [30], profiles).metadata.get(20);
  const reopened = qualityMetadataByRequirement([{
    ...operation(), status: "Ready", completedAt: null, completedQuantity: 0,
  }], [review()], [], profiles).metadata.get(20);
  for (const result of [missing, stale, retracted, reopened]) {
    assert.equal(result?.effectiveQcResult, "pending");
    assert.equal(result?.storageLocation, null);
    assert.equal(result?.locationUpdatedBy, null);
  }
});

test("a failed review remains failed during rework and never exposes a location", () => {
  const rework = { ...operation(), status: "Ready" as const, completedAt: null, completedQuantity: 0 };
  const result = qualityMetadataByRequirement([rework], [review({ result: "failed", rejected_quantity: 1 })], [], profiles).metadata.get(20);
  assert.equal(result?.effectiveQcResult, "failed");
  assert.equal(result?.storageLocation, null);
  assert.deepEqual(result?.lastQualityFailure, {
    notes: "Good",
    rejectedQuantity: 1,
    reviewedAt: "2026-09-05T13:00:00Z",
    reviewedBy: "Robin R.",
  });
});

test("the latest QC failure remains visible after rework and a later pass", () => {
  const failed = review({ id: 29, result: "failed", notes: "Bore oversized", rejected_quantity: 1, reviewed_at: "2026-09-05T11:00:00Z" });
  const passed = review({ id: 30, result: "passed", notes: "Accepted after rerun", reviewed_at: "2026-09-05T13:00:00Z" });
  const result = qualityMetadataByRequirement([operation("2026-09-05T12:00:00Z")], [failed, passed], [], profiles).metadata.get(20);
  assert.equal(result?.effectiveQcResult, "passed");
  assert.deepEqual(result?.lastQualityFailure, {
    notes: "Bore oversized",
    rejectedQuantity: 1,
    reviewedAt: "2026-09-05T11:00:00Z",
    reviewedBy: "Robin R.",
  });
});

test("the latest QC failure remains visible when the completed reroute returns to pending QC", () => {
  const failed = review({ result: "failed", notes: "Thread is undersized", rejected_quantity: 1 });
  const result = qualityMetadataByRequirement(
    [operation("2026-09-05T14:00:00Z")],
    [failed],
    [],
    profiles,
  ).metadata.get(20);
  assert.equal(result?.effectiveQcResult, "pending");
  assert.equal(result?.notes, "");
  assert.equal(result?.lastQualityFailure?.notes, "Thread is undersized");
  assert.equal(result?.lastQualityFailure?.rejectedQuantity, 1);
});

test("cleared locations retain the most recent editor attribution", () => {
  const result = qualityMetadataByRequirement([operation()], [review({ storage_location: null })], [], profiles).metadata.get(20);
  assert.equal(result?.storageLocation, null);
  assert.equal(result?.locationUpdatedBy, "Morgan M.");
  assert.equal(result?.locationUpdatedAt, "2026-09-05T14:00:00Z");
});

test("threaded inserts are excluded from the pre-QC gate and do not stale its review", () => {
  const primary = operation("2026-09-05T12:00:00Z");
  const plannedInsert = {
    ...operation(), id: 11, operationKey: "insert", operationNumber: "OP2" as const,
    machine: "Threaded Insert", status: "Planned" as const, completedQuantity: 0, completedAt: null,
  };
  const pending = projectQualityControl([primary, plannedInsert], [], [], profiles);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].operations.map(({ id }) => id), [10]);

  const completedInsert = {
    ...plannedInsert, status: "Complete" as const, completedQuantity: 1, completedAt: "2026-09-05T15:00:00Z",
  };
  const quality = qualityMetadataByRequirement([primary, completedInsert], [review()], [], profiles).metadata.get(20);
  assert.equal(quality?.effectiveQcResult, "passed");
});

test("production and inspection notes remain separate in the QC projection", () => {
  const [item] = projectQualityControl([operation()], [review({ notes: "Bore accepted" })], [], []);
  assert.equal(item.productionNotes, "Check the bore");
  assert.equal(item.notes, "Bore accepted");
});
