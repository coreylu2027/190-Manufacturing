import test from "node:test";
import assert from "node:assert/strict";

import { qualityMetadataByRequirement, type QualityReviewRow } from "./quality-control.ts";
import type { ManufacturingOperation } from "./types.ts";

function operation(completedAt = "2026-09-05T12:00:00Z"): ManufacturingOperation {
  return {
    id: 10, requirementId: 20, operationKey: "fixture", partNumber: "P-1", revision: null,
    partName: "Fixture", assemblyNumber: "A-1", documentName: null, material: null,
    quantity: 1, taskQuantity: 1, claimedQuantity: 0, completedQuantity: 1,
    availableQuantity: 0, allocations: [], operationNumber: "OP1", workType: "Manufacturing",
    machine: "Mill", status: "Complete", machinist: "Alex A.", startedAt: null, completedAt,
    activeInRouting: true, camProgramPath: null, camNotes: "", camDependency: null,
    drawingUrl: null, hasDrawingPdf: false, drawingPdfName: null, hasStepFile: false,
    stepName: null, onshapeUrl: null, storageLocation: null, locationUpdatedBy: null,
    locationUpdatedAt: null, effectiveQcResult: "pending",
  };
}

function review(overrides: Partial<QualityReviewRow> = {}): QualityReviewRow {
  return {
    id: 30, production_requirement_id: 20, operation_id: null, result: "passed", notes: "Good",
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
  for (const result of [missing, stale, retracted]) {
    assert.equal(result?.effectiveQcResult, "pending");
    assert.equal(result?.storageLocation, null);
    assert.equal(result?.locationUpdatedBy, null);
  }
});

test("a failed review remains failed during rework and never exposes a location", () => {
  const rework = { ...operation(), status: "Needs Rework" as const, completedAt: null };
  const result = qualityMetadataByRequirement([rework], [review({ result: "failed" })], [], profiles).metadata.get(20);
  assert.equal(result?.effectiveQcResult, "failed");
  assert.equal(result?.storageLocation, null);
});

test("cleared locations retain the most recent editor attribution", () => {
  const result = qualityMetadataByRequirement([operation()], [review({ storage_location: null })], [], profiles).metadata.get(20);
  assert.equal(result?.storageLocation, null);
  assert.equal(result?.locationUpdatedBy, "Morgan M.");
  assert.equal(result?.locationUpdatedAt, "2026-09-05T14:00:00Z");
});
