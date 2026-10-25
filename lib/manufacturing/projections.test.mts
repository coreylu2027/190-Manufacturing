import test from "node:test";
import assert from "node:assert/strict";

import { projectCotsRequirements, projectFinishing, projectOperations } from "./projections.ts";
import { requirementStatus } from "../production-status.ts";

const requirement = {
  id: 2,
  part_id: 3,
  required_quantity: 2,
  status: "Ready for Finishing",
};

test("hidden obsolete history retains visibility metadata for the admin archive", () => {
  const archived = { ...requirement, obsolete: true, hidden: true, visibility_version: 3, active_in_bom: false };
  const [op] = projectOperations([{ ...operation, active_in_routing: false }], [archived], [part]);
  assert.equal(op.hidden, true);
  assert.equal(op.visibilityVersion, 3);
  assert.equal(op.obsolete, true);
  const [job] = projectFinishing([{ ...finishing, active: false }], [archived]);
  assert.equal(job.hidden, true);
  assert.equal(job.visibilityVersion, 3);
});
const operation = {
  id: 1,
  operation_key: "root|part|OP1",
  requirement_id: 2,
  operation_number: "OP1",
  work_type: "Manufacturing",
  machine: "Mill",
  status: "Ready",
  active_in_routing: true,
};
const part = {
  id: 3,
  material: "Aluminum",
  drawing_files: [{ url: "https://legacy-source.invalid/legacy.pdf", visible_name: "legacy.pdf" }],
  step_files: [{ url: "https://legacy-source.invalid/legacy.step", visible_name: "legacy.step" }],
};
test("production stays pending until required powder coating completes, including post-finishing inserts", () => {
  const coatedRequirement = { ...requirement, finishing: "Black", qc_outcome: "Passed" };
  const completedOperation = { ...operation, status: "Complete" };
  const [pendingQc] = projectOperations([completedOperation], [coatedRequirement], [part]);
  assert.equal(requirementStatus([pendingQc]), "QC Pending");
  const passed = { ...pendingQc, effectiveQcResult: "passed" as const };
  assert.equal(requirementStatus([passed]), "Finishing Pending");
  assert.equal(requirementStatus([{ ...passed, status: "In Progress" }]), "In Progress");
  const inserts = { ...passed, id: 5, machine: "Threaded Insert", status: "Planned" as const };
  assert.equal(requirementStatus([passed, inserts]), "Finishing Pending");

  const finished = projectOperations([completedOperation], [{ ...coatedRequirement, status: "Complete" }], [part])
    .map(row => ({ ...row, effectiveQcResult: "passed" as const }));
  assert.equal(requirementStatus(finished), "Complete");
  assert.equal(requirementStatus([...finished, { ...inserts, finishingComplete: true, status: "Ready" }]), "Ready");
  assert.equal(requirementStatus([{ ...passed, finishingRequired: false }]), "Complete");
});
const finishing = {
  id: 4,
  production_key: "root|part",
  requirement_id: 2,
  active: true,
};
const attachments = [
  { partId: 3, kind: "drawing-pdf" as const, position: 0, originalName: "P-1 REV B.pdf" },
  { partId: 3, kind: "step" as const, position: 0, originalName: "P-1 REV B.step" },
];

test("obsolete and restored historical requirements remain visible without resurrecting deactivated stages of active routes", () => {
  const historical = { ...requirement, obsolete: true, obsoletion_version: 1, active_in_bom: false,
    required_part_revision: "A", obsoletion_origin: "automatic", obsolete_replacement_id: 99 };
  const done = { ...operation, active_in_routing: false, status: "Complete", completed_quantity: 2 };
  const [projected] = projectOperations([done], [historical], [part]);
  assert.equal(projected.obsolete, true);
  assert.equal(projected.completedQuantity, 2);
  assert.equal(projected.revision, "A");
  assert.equal(projected.activeInRouting, false);
  assert.equal(projected.replacementRequirementId, 99);
  const [restored] = projectOperations([done], [{ ...historical, obsolete: false, obsoletion_version: 2 }], [part]);
  assert.equal(restored.obsolete, false);
  assert.equal(restored.activeInRouting, false);
  assert.equal(restored.status, "Complete");
  assert.equal(projectFinishing([{ ...finishing, active: false }], [historical])[0].obsolete, true);
  assert.equal(projectOperations([done], [requirement], [part]).length, 0);
  const active = { ...operation, id: 8, operation_key: "new-route" };
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
    operation_key: "root|part|OP2",
    operation_number: "OP2",
    machine: "Threaded Insert",
    status: "Ready",
  };
  const awaitingFinishing = {
    ...requirement,
    finishing: "Black",
    qc_outcome: "Passed",
    status: "Ready for Finishing",
  };
  assert.equal(projectOperations([threadedInsert], [awaitingFinishing], [part])[0].status, "Planned");

  const finishingComplete = { ...awaitingFinishing, status: "Ready for Manufacturing" };
  assert.equal(projectOperations([threadedInsert], [finishingComplete], [part])[0].status, "Ready");
  assert.equal(projectFinishing([finishing], [finishingComplete], [], [threadedInsert])[0].status, "Complete");
});

test("requirement projections include independent location and lifecycle details", () => {
  const [projected] = projectOperations([operation], [{
    ...requirement,
    production_key: "root|part",
    configuration: "Main",
    bom_positions: "2, 5",
    finishing: "Black",
    qc_outcome: "Passed",
    status: "Ready for Manufacturing",
    part_location: "Shelf 2",
    production_notes: "Deburr before inspection",
    location_updated_by: "Morgan M.",
    location_updated_at: "2026-09-05T15:00:00Z",
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
    part_location: "Shelf 2",
    production_notes: "Keep masking installed",
    location_updated_by: "Morgan M.",
    location_updated_at: "2026-09-05T15:00:00Z",
  }]);
  assert.equal(projectedFinishing.storageLocation, "Shelf 2");
  assert.equal(projectedFinishing.locationUpdatedBy, "Morgan M.");
  assert.equal(projectedFinishing.productionNotes, "Keep masking installed");
});

 test("production status identifies pending QC before completion and post-QC inserts", () => {
  const completed = projectOperations([{ ...operation, status: "Complete" }], [requirement], [part]);
  assert.equal(requirementStatus(completed), "QC Pending");
  const inserts = { ...completed[0], id: 5, machine: "Threaded Insert", status: "Planned" as const };
  assert.equal(requirementStatus([...completed, inserts]), "QC Pending");
  assert.equal(requirementStatus(completed.map(row => ({ ...row, effectiveQcResult: "passed" as const }))), "Complete");
  assert.equal(requirementStatus(completed.map(row => ({ ...row, status: "In Progress" as const }))), "In Progress");
  assert.equal(requirementStatus(completed.map(row => ({ ...row, workType: "CAM" as const }))), "Complete");
  assert.notEqual(requirementStatus(completed.map(row => ({ ...row, effectiveQcResult: "failed" as const }))), "QC Pending");
});

test("off-the-shelf requirements keep their retired routes visible with an Off the Shelf production status", () => {
  const bought = { ...requirement, off_the_shelf: true, active_in_bom: true };
  const [op] = projectOperations([{ ...operation, active_in_routing: false }], [bought], [part]);
  assert.equal(op.offTheShelf, true);
  assert.equal(op.activeInRouting, false);
  assert.equal(requirementStatus([op]), "Off the Shelf");
  assert.equal(projectOperations([{ ...operation, active_in_routing: false }], [{ ...requirement, active_in_bom: true }], [part]).length, 0);
});

test("imported subassembly parts report the document of the root assembly they were synced through", () => {
  const assemblies = [{ id: 10, assembly_number: "A-ROOT" }, { id: 11, assembly_number: "A-ROLLER" }, { id: 12, assembly_number: "A-OTHER" }];
  const row = (id: number, assembly: number, document: string, extra: Record<string, unknown> = {}) => ({
    ...requirement, id, assembly_id: assembly, source_root: assembly === 12 ? "A-OTHER" : "A-ROOT",
    source_document: document, active_in_bom: true, ...extra,
  });
  const requirements = [
    row(20, 10, "A-26C-0004"), row(21, 10, "A-26C-0004"), row(22, 10, "Imported bracket"),
    row(23, 10, "Retired document", { obsolete: true }), row(24, 10, "Retired document", { obsolete: true }),
    row(25, 11, "Configurable Roller"),
    // A root whose only direct part is inactive still resolves.
    row(26, 12, "A-26C-0009", { active_in_bom: false }),
  ];
  const operations = requirements.map((item) => ({ ...operation, id: item.id, operation_key: `op-${item.id}`, requirement_id: item.id }));
  const byRequirement = new Map(projectOperations(operations, requirements, [part], [], assemblies).map((op) => [op.requirementId, op]));
  assert.deepEqual([byRequirement.get(25)?.documentName, byRequirement.get(25)?.syncedFromDocument], ["Configurable Roller", "A-26C-0004"]);
  assert.equal(byRequirement.get(22)?.syncedFromDocument, "A-26C-0004");
  assert.equal(byRequirement.get(26)?.syncedFromDocument, "A-26C-0009");
});

test("COTS requirements without routing are projected for production with their location", () => {
  const cotsPart = { id: 7, part_number: "WCP-0215", name: "Bearing", vendor: "WCP", cots: true };
  const assembly = { id: 9, assembly_number: "A-1" };
  const cotsRequirement = {
    id: 8, part_id: 7, assembly_id: 9, required_quantity: 6, active_in_bom: true,
    production_key: "A-1|A|A-1|WCP-0215|default|v2", source_root: "A-1",
    part_location: "Shelf 2", location_updated_by: "Sam", location_updated_at: "2026-09-26T00:00:00Z",
  };
  const removed = { ...cotsRequirement, id: 10, active_in_bom: false };
  const obsolete = { ...removed, id: 11, obsolete: true, obsoletion_version: 1 };
  const made = { ...cotsRequirement, id: 12, part_id: 3 };
  const [projected, ...rest] = projectCotsRequirements([cotsRequirement, removed, obsolete, made], [cotsPart, part], [assembly]);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].requirementId, 11);
  assert.equal(projected.requirementId, 8);
  assert.equal(projected.partNumber, "WCP-0215");
  assert.equal(projected.assemblyNumber, "A-1");
  assert.equal(projected.vendor, "WCP");
  assert.equal(projected.quantity, 6);
  assert.equal(projected.storageLocation, "Shelf 2");
  assert.equal(projected.locationUpdatedBy, "Sam");
  // A COTS requirement that has been given routing belongs to the operations projection.
  assert.deepEqual(projectCotsRequirements([cotsRequirement], [cotsPart], [assembly], [{ requirementId: 8 }]), []);
});
