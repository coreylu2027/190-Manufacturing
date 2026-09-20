import test from "node:test";
import assert from "node:assert/strict";

import { ENTITIES, normalizeRow, runtimeRow, type NormalizedRow, type RawRow } from "./model.ts";
import { createSupabaseWriteAdapter, ManufacturingWriteError, type WriteState } from "./write-adapter.ts";
import { formatSlackManufacturingEvent } from "../slack-notifications-core.ts";

const ACTOR = { id: "00000000-0000-4000-8000-000000000190", name: "Alex A." };

for (const metadata of ["absent", "stale"] as const) {
  test(`native CAM claims resolve current identities with ${metadata} migration metadata`, async () => {
    const state = fixture({ operation: { "Work Type": { value: "CAM" } } });
    for (const records of Object.values(state.rows)) for (const row of records) {
      delete row.baserow_id;
      delete row.source_row;
      if (metadata === "stale") row.source_row = { id: row.id,
        "Production Requirement": [{ id: 20, value: "OLD — Obsolete [OLD-ASSEMBLY]" }],
        Status: { value: "Complete" }, "Claimed Quantity": 999 };
    }
    state.rows.assemblies[0].assembly_number = "a26c-0002";
    const { adapter, commits } = harness(state);
    const result = await adapter.applyQuantityAction(10, "claim", 1, ACTOR);
    const payload = formatSlackManufacturingEvent({ ...result.notificationContext,
      type: "operation_claimed", actorName: ACTOR.name, quantity: 1 });
    assert.match(payload.text, /P-1 — Fixture/);
    assert.match(JSON.stringify(payload.blocks), /Assembly a26c-0002/);
    assert.doesNotMatch(JSON.stringify(payload), /OLD|Unknown|Unassigned/);
    assert.equal(commits.length, 1);
  });
}

test("write snapshots without identity tables load current part and assembly columns", async () => {
  const state = fixture();
  const parts = state.rows.parts;
  const assemblies = state.rows.assemblies;
  delete state.rows.parts;
  delete state.rows.assemblies;
  const entities: string[] = [];
  const adapter = createSupabaseWriteAdapter({ url: "https://example.test", serviceKey: "test", fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("manufacturing_write_state")) return Response.json(state);
    const entity = url.searchParams.get("p_entity");
    if (entity) {
      entities.push(entity);
      const rows = entity === "parts" ? parts : assemblies;
      return Response.json({ rows, total: rows.length });
    }
    if (url.pathname.endsWith("manufacturing_commit_with_qc_quantities")) {
      return Response.json(JSON.parse(String(init?.body)).p_result);
    }
    throw new Error("Unexpected request");
  } });
  const result = await adapter.applyQuantityAction(10, "claim", 1, ACTOR);
  assert.equal(result.notificationContext.partNumber, "P-1");
  assert.equal(result.notificationContext.partName, "Fixture");
  assert.equal(result.notificationContext.assemblyNumber, "A-1");
  assert.deepEqual(entities.sort(), ["assemblies", "parts"]);
});

test("Force QC preserves completed credit, clears claims, includes CAM, and commits one passed review", async () => {
  const state = fixture({ operation: {
    Status: { value: "In Progress" }, "Completed Quantity": 1, "Claimed Quantity": 1,
    "Quantity Ledger": JSON.stringify([{ userId: "other", name: "Other", claimed: 1, completed: 1 }]),
  } });
  state.rows.operations.push(normalized("operations", {
    id: 12, Operation: "fixture|OP1|CAM", "Production Requirement": [{ id: 20 }],
    "Operation Number": { value: "OP1" }, "Work Type": { value: "CAM" }, "Active in Routing": true,
    Status: { value: "Planned" }, "CAM Program Path": "existing.nc", "CAM Notes": "Keep this",
  }));
  const { adapter, commits } = harness(state);
  const preview = await adapter.previewForceQuality(20);
  assert.equal(commits.length, 0);
  assert.equal(preview.operations.length, 2);
  assert.match(preview.generatedNotes, /CAM/);
  assert.match(preview.generatedNotes, /In Progress/);
  await adapter.forceQualityReview(20, "Edited inspection", preview.token, ACTOR);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].p_action, "qc_review");
  const changes = commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  const machining = changes.find(change => change.entity === "operations" && change.id === 10)!.patch;
  assert.equal(machining.claimed_quantity, 0);
  assert.equal(machining.completed_quantity, 2);
  assert.deepEqual(JSON.parse(String(machining.quantity_ledger)), [
    { userId: "other", name: "Other", claimed: 0, completed: 1 },
    { userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 1 },
  ]);
  const cam = changes.find(change => change.entity === "operations" && change.id === 12)!.patch;
  assert.equal(cam.completed_quantity, 1);
  assert.equal(cam.cam_program_path, undefined);
  assert.equal(cam.cam_notes, undefined);
  const qc = commits[0].p_qc as Record<string, unknown>;
  assert.equal(qc.notes, "Edited inspection");
  assert.equal(qc.reviewed_at, machining.completed_at);
  assert.equal(qc.result, "passed");
  assert.equal(changes.find(change => change.entity === "requirements")!.patch.status, "Complete");
});

test("Force QC can fail an unfinished batch and return it to manufacturing atomically", async () => {
  const { adapter, commits } = harness(withThreadedInsert(fixture({ operation: {
    Status: { value: "In Progress" }, "Completed Quantity": 1, "Claimed Quantity": 1,
    "Quantity Ledger": JSON.stringify([{ userId: "other", name: "Other", claimed: 1, completed: 1 }]),
  } })));
  const preview = await adapter.previewForceQuality(20);
  const review = await adapter.forceQualityReview(20, "Rejected batch", preview.token, ACTOR, "failed");
  assert.equal(review.result, "failed");
  assert.equal(review.notificationContext.requirementStatus, "Ready for Manufacturing");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].p_action, "qc_review");
  const qc = commits[0].p_qc as Record<string, unknown>;
  assert.equal(qc.result, "failed");
  assert.equal(qc.notes, "Rejected batch");
  const changes = commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  const machining = changes.find(change => change.entity === "operations" && change.id === 10)!.patch;
  assert.equal(machining.status, "Ready");
  assert.equal(machining.claimed_quantity, 0);
  assert.equal(machining.completed_quantity, 0);
  assert.deepEqual(JSON.parse(String(machining.quantity_ledger)), []);
  const requirement = changes.find(change => change.entity === "requirements")!.patch;
  assert.equal(requirement.qc_outcome, "Failed");
  assert.equal(changes.find(change => change.entity === "operations" && change.id === 11), undefined);
});

test("Force QC routes finishing and post-QC work without completing inserts", async () => {
  for (const finishing of ["None", "Black"]) {
    const state = withThreadedInsert(fixture({ requirement: { Finishing: { value: finishing } } }));
    const { adapter, commits } = harness(state);
    const preview = await adapter.previewForceQuality(20);
    assert.equal(preview.operations.length, 1);
    assert.equal(preview.nextDestination, finishing === "None" ? "Post-QC manufacturing" : "Finishing");
    await adapter.forceQualityReview(20, "", preview.token, ACTOR);
    const changes = commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
    const insert = changes.find(change => change.entity === "operations" && change.id === 11);
    assert.equal(insert?.patch.status, finishing === "None" ? "Ready" : undefined);
    assert.equal(insert?.patch.completed_quantity, undefined);
    assert.equal((commits[0].p_qc as Record<string, unknown>).notes, "");
  }
});

test("Force QC rejects stale previews, inactive requirements, completed prerequisites, and current passes", async () => {
  const stale = harness(fixture());
  await assert.rejects(stale.adapter.forceQualityReview(20, "", "old-token", ACTOR), /Refresh the preview/);
  assert.equal(stale.commits.length, 0);
  const inactive = harness(fixture({ requirement: { "Active in BOM": false } }));
  await assert.rejects(inactive.adapter.previewForceQuality(20), /inactive/);
  const complete = harness(fixture({ operation: { Status: { value: "Complete" }, "Completed Quantity": 2 } }));
  await assert.rejects(complete.adapter.previewForceQuality(20), /normal QC/);
  const passed = harness(fixture({ operation: { Status: { value: "Complete" }, "Completed Quantity": 2 }, reviews: [{
    id: 1, production_requirement_id: 20, operation_id: null, result: "passed", reviewed_at: "2026-09-01T00:00:00Z",
  }] }));
  await assert.rejects(passed.adapter.previewForceQuality(20), /current QC pass/);
});

test("Force QC ignores inactive and duplicate rows and preserves already completed operations", async () => {
  const state = fixture();
  state.rows.operations.push({ ...state.rows.operations[0], id: 11, status: "Complete", completed_quantity: 2 });
  state.rows.operations.push({ ...state.rows.operations[0], id: 12, operation_key: "inactive", active_in_routing: false });
  state.rows.operations.push({ ...state.rows.operations[0], id: 13, operation_key: "fixture|OP2|Manufacturing", operation_number: "OP2" });
  const { adapter, commits } = harness(state);
  const preview = await adapter.previewForceQuality(20);
  assert.deepEqual(preview.operations.map(op => op.id), [13]);
  await adapter.forceQualityReview(20, preview.generatedNotes, preview.token, ACTOR);
  const changes = commits[0].p_changes as Array<{ entity: string; id: number }>;
  assert.deepEqual(changes.filter(change => change.entity === "operations").map(change => change.id), [13]);
});

test("Force QC transport retries reuse the atomic payload and database conflicts do not retry", async () => {
  const retry = harness(fixture(), (body, attempt) => { if (attempt === 1) throw new TypeError("Transport lost"); return Response.json(body.p_result); });
  await retry.adapter.forceQualityReview(20, "", "fixture-token", ACTOR);
  assert.equal(retry.commits.length, 2);
  assert.deepEqual(retry.commits[0], retry.commits[1]);
  const conflict = harness(fixture(), () => Response.json({ code: "PT409" }, { status: 409 }));
  await assert.rejects(conflict.adapter.forceQualityReview(20, "", "fixture-token", ACTOR), error => error instanceof ManufacturingWriteError && error.status === 409);
  assert.equal(conflict.commits.length, 1);

  const timeout = harness(fixture(), () => Response.json({ code: "57014" }, { status: 500 }));
  await assert.rejects(timeout.adapter.forceQualityReview(20, "", "fixture-token", ACTOR), error => error instanceof ManufacturingWriteError
    && error.status === 503 && /database is busy/.test(error.message));
  assert.equal(timeout.commits.length, 1);
});

test("Force QC normalizes legacy rework rows and propagates database permission rejection without changing its input state", async () => {
  const state = fixture({ operation: { Status: { value: "Needs Rework" } }, requirement: { "QC Outcome": { value: "Failed" } } });
  const original = structuredClone(state);
  const denied = harness(state, () => Response.json({ code: "42501" }, { status: 403 }));
  const preview = await denied.adapter.previewForceQuality(20);
  assert.equal(preview.operations[0].previousStatus, "Ready");
  await assert.rejects(denied.adapter.forceQualityReview(20, "Rework inspected", preview.token, ACTOR), error => error instanceof ManufacturingWriteError && error.status === 403);
  assert.equal(denied.commits.length, 1);
  assert.deepEqual(state, original);
});

function normalized(entityName: string, raw: RawRow): NormalizedRow {
  const entity = ENTITIES.find((candidate) => candidate.name === entityName);
  assert.ok(entity);
  const row = normalizeRow(entity, raw) as NormalizedRow;
  delete row.source_row;
  delete row.baserow_id;
  return row;
}

function fixture(options: {
  operation?: Partial<RawRow>;
  requirement?: Partial<RawRow>;
  finishing?: Partial<RawRow>;
  reviews?: WriteState["reviews"];
  retractions?: WriteState["retractions"];
} = {}): WriteState {
  const requirement = normalized("requirements", {
    id: 20,
    "Production Key": "fixture",
    Part: [{ id: 40 }], Assembly: [{ id: 50 }],
    "Required Quantity": 2,
    Finishing: { value: "None" },
    "Active in BOM": true,
    Status: { value: "Ready for Manufacturing" },
    Machinist: "",
    "QC Outcome": { value: "Not Inspected" },
    "QC Notes": "",
    "QC Reviewed By": "",
    ...options.requirement,
  });
  const operation = normalized("operations", {
    id: 10,
    Operation: "fixture|OP1|Manufacturing",
    "Production Requirement": [{ id: 20, value: "P-1 — Fixture [A-1]" }],
    "Operation Number": { value: "OP1" },
    Machine: { value: "Mill" },
    "Work Type": { value: "Manufacturing" },
    "Active in Routing": true,
    Status: { value: "Ready" },
    Machinist: "",
    "Claimed Quantity": 0,
    "Completed Quantity": 0,
    "Quantity Ledger": "",
    ...options.operation,
  });
  const finishing = normalized("finishing", {
    id: 30,
    "Production Key": "fixture",
    "Production Requirement": [{ id: 20, value: "P-1 — Fixture [A-1]" }],
    Active: true,
    Machinist: "",
    ...options.finishing,
  });
  return {
    token: "fixture-token",
    rows: { parts: [{ id: 40, part_number: "P-1", name: "Fixture" }], assemblies: [{ id: 50, assembly_number: "A-1" }], operations: [operation], requirements: [requirement], finishing: [finishing] },
    reviews: options.reviews ?? [],
    retractions: options.retractions ?? [],
  };
}

function withThreadedInsert(state: WriteState, overrides: Partial<RawRow> = {}) {
  state.rows.operations.push(normalized("operations", {
    id: 11,
    Operation: "fixture|OP2|Manufacturing",
    "Production Requirement": [{ id: 20, value: "P-1 — Fixture [A-1]" }],
    "Operation Number": { value: "OP2" },
    Machine: { value: "Threaded Insert" },
    "Work Type": { value: "Manufacturing" },
    "Active in Routing": true,
    Status: { value: "Planned" },
    Machinist: "",
    "Claimed Quantity": 0,
    "Completed Quantity": 0,
    "Quantity Ledger": "",
    ...overrides,
  }));
  return state;
}

function harness(state: WriteState, commitResponse?: (body: Record<string, unknown>, attempt: number) => Response | Promise<Response>) {
  const commits: Record<string, unknown>[] = [];
  let attempts = 0;
  const adapter = createSupabaseWriteAdapter({
    url: "https://example.test",
    serviceKey: "test-service-key",
    fetch: async (input, init) => {
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-service-key");
      if (String(input).endsWith("/manufacturing_write_state")) {
        assert.equal(init?.method, "GET");
        return Response.json(state);
      }
      assert.ok(String(input).endsWith("/manufacturing_commit_with_qc_quantities")
        || String(input).endsWith("/manufacturing_commit_with_operation_location")
        || String(input).endsWith("/manufacturing_update_requirement_notes")
        || String(input).endsWith("/manufacturing_set_requirement_obsolete")
        || String(input).endsWith("/manufacturing_set_requirement_hidden"));
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      commits.push(body);
      attempts += 1;
      return commitResponse?.(body, attempts) ?? Response.json(body.p_result);
    },
  });
  return { adapter, commits };
}

test("quantity claims are planned and sent as one compare-and-swap transaction", async () => {
  const { adapter, commits } = harness(fixture());
  const result = await adapter.applyQuantityAction(10, "claim", 1, ACTOR);
  assert.equal(result.status, "In Progress");
  assert.deepEqual(result.notificationContext, {
    requirementId: 20,
    partNumber: "P-1",
    partName: "Fixture",
    assemblyNumber: "A-1",
    operationNumber: "OP1",
    workType: "Manufacturing",
    machine: "Mill",
    previousRequirementStatus: "Ready for Manufacturing",
    requirementStatus: "On Machine",
  });
  assert.equal(commits.length, 1);
  const commit = commits[0];
  assert.equal(commit.p_action, "claim");
  assert.equal(commit.p_expected, "fixture-token");
  assert.equal(commit.p_actor, ACTOR.id);
  const changes = commit.p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  assert.deepEqual(changes.map(({ entity, id }) => ({ entity, id })), [
    { entity: "requirements", id: 20 },
    { entity: "operations", id: 10 },
  ]);
  const operation = changes.find((change) => change.entity === "operations")?.patch;
  assert.equal(operation?.status, "In Progress");
  assert.equal(operation?.claimed_quantity, 1);
  assert.equal(operation?.completed_quantity, 0);
  assert.match(String(operation?.quantity_ledger), /"claimed":1/);
});

test("print claims save their printer in the same transaction and omission leaves location alone", async () => {
  const state = fixture({ operation: { Machine: { value: "Bambu 3D Printer" } } });
  const { adapter, commits } = harness(state);
  const result = await adapter.applyQuantityAction(10, "claim", 1, ACTOR, { location: "Bambu X1C #2" });
  assert.equal(result.storageLocation, "Bambu X1C #2");
  assert.equal(result.locationUpdatedBy, ACTOR.name);
  assert.equal(result.claimedQuantity, 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].p_qc, null);
  const unchanged = await adapter.applyQuantityAction(10, "claim", 1, ACTOR);
  assert.equal(Object.hasOwn(unchanged, "storageLocation"), false);
});

test("another user can complete all print claims and move the part without stealing credit or bypassing QC", async () => {
  const allocations = [
    { userId: "other-1", name: "Other A.", claimed: 1, completed: 0 },
    { userId: "other-2", name: "Other B.", claimed: 1, completed: 0 },
  ];
  const state = fixture({ operation: {
    Machine: { value: "Bambu 3D Printer" }, Status: { value: "In Progress" },
    "Claimed Quantity": 2, "Quantity Ledger": JSON.stringify(allocations),
  } });
  const { adapter, commits } = harness(state);
  const result = await adapter.applyQuantityAction(10, "complete", 2, ACTOR, { completeAllClaims: true, location: "Clarke 1" });
  assert.equal(result.status, "Complete");
  assert.equal(result.claimedQuantity, 0);
  assert.equal(result.storageLocation, "Clarke 1");
  assert.equal(result.notificationContext.requirementStatus, "Ready for QC");
  assert.deepEqual(result.allocations, allocations.map((a) => ({ ...a, claimed: 0, completed: 1 })));
  assert.equal(commits[0].p_actor, ACTOR.id);
  assert.equal(commits.length, 1);
  await assert.rejects(adapter.applyQuantityAction(10, "complete", 1, ACTOR, { completeAllClaims: true }), /claims changed/);
  assert.equal(commits.length, 1);
});

test("completion location is optional for ordinary manufacturing and forbidden on release or CAM", async () => {
  const state = fixture({ operation: {
    Status: { value: "In Progress" }, "Claimed Quantity": 2,
    "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 2, completed: 0 }]),
  } });
  const { adapter, commits } = harness(state);
  const result = await adapter.applyQuantityAction(10, "complete", 2, ACTOR, { location: "Shelf 2" });
  assert.equal(result.storageLocation, "Shelf 2");
  await assert.rejects(adapter.applyQuantityAction(10, "complete", 2, ACTOR, { completeAllClaims: true }), /Only 3D printing/);
  await assert.rejects(adapter.applyQuantityAction(10, "release", 2, ACTOR, { location: "Shelf 2" }), /Set a location/);
  await assert.rejects(adapter.applyQuantityAction(10, "complete", 2, ACTOR, { location: "On Robot" }), /after QC/);
  assert.equal(commits.length, 1);
  const cam = harness(fixture({ operation: { "Work Type": { value: "CAM" } } }));
  await assert.rejects(cam.adapter.applyQuantityAction(10, "claim", 1, ACTOR, { location: "Bambu H2D" }), /Set a location/);
  assert.equal(cam.commits.length, 0);
});

test("print completion and location retry with the identical idempotency payload", async () => {
  const retry = harness(fixture({ operation: { Machine: { value: "Bambu 3D Printer" } } }), (body, attempt) => {
    if (attempt === 1) throw new TypeError("connection reset after commit");
    return Response.json(body.p_result);
  });
  await retry.adapter.applyQuantityAction(10, "claim", 1, ACTOR, { location: "Bambu X1C Pit" });
  assert.equal(retry.commits.length, 2);
  assert.deepEqual(retry.commits[0], retry.commits[1]);
});

test("approved users can update a requirement production note independently of QC", async () => {
  const { adapter, commits } = harness(fixture());
  const result = await adapter.updateRequirementNotes(20, "Leave soft jaws with the part", ACTOR);

  assert.deepEqual(result, { requirementId: 20, productionNotes: "Leave soft jaws with the part" });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].p_requirement_id, 20);
  assert.equal(commits[0].p_notes, "Leave soft jaws with the part");
  assert.equal(commits[0].p_expected, "fixture-token");
  assert.equal(commits[0].p_actor, ACTOR.id);
  assert.equal(commits[0].p_changes, undefined);
  assert.equal(commits[0].p_qc, undefined);
});

test("CAM completion, finishing, claim stealing, and QC use their atomic action envelopes", async () => {
  const camState = fixture({ operation: {
    Operation: "fixture|OP1|CAM", Machine: { value: "Haas" }, "Work Type": { value: "CAM" },
    Status: { value: "In Progress" }, Machinist: "Alex A.", "Claimed Quantity": 1,
    "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 1, completed: 0 }]),
  }});
  const cam = harness(camState);
  await cam.adapter.applyQuantityAction(10, "complete", 1, ACTOR, { programPath: "shop/program.nc", notes: "Verified" });
  assert.equal(cam.commits[0].p_action, "complete");
  const camPatch = (cam.commits[0].p_changes as Array<{ entity: string; patch: Record<string, unknown> }>).find((change) => change.entity === "operations")?.patch;
  assert.equal(camPatch?.cam_program_path, "shop/program.nc");
  assert.equal(camPatch?.cam_notes, "Verified");

  const finishing = harness(fixture({ requirement: { Status: { value: "Ready for Finishing" }, Finishing: { value: "Black" } } }));
  await finishing.adapter.applyFabricationAction(30, "claim", ACTOR);
  assert.equal(finishing.commits[0].p_action, "finishing_claim");
  assert.deepEqual((finishing.commits[0].p_changes as Array<{ entity: string }>).map((change) => change.entity), ["finishing"]);

  const otherId = "00000000-0000-4000-8000-000000000191";
  const steal = harness(fixture({ operation: {
    Status: { value: "In Progress" }, Machinist: "Blake B. (2)", "Claimed Quantity": 2,
    "Quantity Ledger": JSON.stringify([{ userId: otherId, name: "Blake B.", claimed: 2, completed: 0 }]),
  }}));
  const stolen = await steal.adapter.stealOperationClaim(10, ACTOR);
  assert.deepEqual(stolen.displaced, [{ userId: otherId, name: "Blake B.", quantity: 2 }]);
  assert.equal(steal.commits[0].p_action, "steal");

  const qc = harness(fixture({
    operation: {
      Status: { value: "Complete" }, Machinist: "Alex A. (2)", "Claimed Quantity": 0, "Completed Quantity": 2,
      "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      "Completed At": "2026-09-05T00:00:00Z",
    },
    requirement: { Status: { value: "Ready for QC" }, Machinist: "Alex A. (2)" },
  }));
  const qcResult = await qc.adapter.recordQualityReview(20, "passed", "Looks good", ACTOR, "Clarke 1");
  assert.deepEqual(qcResult.notificationContext, {
    requirementId: 20,
    partNumber: "P-1",
    partName: "Fixture",
    assemblyNumber: "A-1",
    previousRequirementStatus: "Ready for QC",
    requirementStatus: "Complete",
  });
  assert.equal(qc.commits[0].p_action, "qc_review");
  assert.equal((qc.commits[0].p_qc as { result: string }).result, "passed");
  assert.equal((qc.commits[0].p_qc as { location: string }).location, "Clarke 1");
  assert.equal((qc.commits[0].p_changes as Array<{ entity: string }>).length, 1);
});

test("partial QC rejection reopens every physical stage in order and leaves CAM complete", async () => {
  const otherId = "00000000-0000-4000-8000-000000000191";
  const state = fixture({
    requirement: { "Required Quantity": 5, Status: { value: "Ready for QC" } },
    operation: {
      Status: { value: "Complete" }, Machinist: "Other (2), Alex A. (3)", "Completed Quantity": 5,
      "Quantity Ledger": JSON.stringify([
        { userId: otherId, name: "Other", claimed: 0, completed: 2 },
        { userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 3 },
      ]),
      "Completed At": "2026-09-05T12:00:00Z",
    },
  });
  state.rows.operations.push(normalized("operations", {
    id: 11, Operation: "fixture|OP2|Manufacturing", "Production Requirement": [{ id: 20, value: "P-1 — Fixture [A-1]" }],
    "Operation Number": { value: "OP2" }, Machine: { value: "Lathe" }, "Work Type": { value: "Manufacturing" },
    "Active in Routing": true, Status: { value: "Complete" }, Machinist: "Alex A. (3), Other (2)",
    "Claimed Quantity": 0, "Completed Quantity": 5, "Completed At": "2026-09-05T13:00:00Z",
    "Quantity Ledger": JSON.stringify([
      { userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 3 },
      { userId: otherId, name: "Other", claimed: 0, completed: 2 },
    ]),
  }));
  state.rows.operations.push(normalized("operations", {
    id: 12, Operation: "fixture|OP1|CAM", "Production Requirement": [{ id: 20, value: "P-1 — Fixture [A-1]" }],
    "Operation Number": { value: "OP1" }, Machine: { value: "Haas CNC" }, "Work Type": { value: "CAM" },
    "Active in Routing": true, Status: { value: "Complete" }, Machinist: "Alex A.",
    "Claimed Quantity": 0, "Completed Quantity": 1, "Completed At": "2026-09-05T11:00:00Z",
    "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 1 }]),
    "CAM Program Path": "programs/fixture.nc", "CAM Notes": "Keep",
  }));

  const qc = harness(state);
  const result = await qc.adapter.recordQualityReview(20, "failed", "Bore is oversized", ACTOR, null, 2);
  assert.equal(result.rejectedQuantity, 2);
  const commit = qc.commits[0];
  assert.equal((commit.p_qc as Record<string, unknown>).rejected_quantity, 2);
  const changes = commit.p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  const op1 = changes.find((change) => change.entity === "operations" && change.id === 10)?.patch;
  const op2 = changes.find((change) => change.entity === "operations" && change.id === 11)?.patch;
  assert.equal(op1?.status, "Ready");
  assert.equal(op1?.claimed_quantity, 0);
  assert.equal(op1?.completed_quantity, 3);
  assert.deepEqual(JSON.parse(String(op1?.quantity_ledger)), [
    { userId: otherId, name: "Other", claimed: 0, completed: 2 },
    { userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 1 },
  ]);
  assert.equal(op2?.status, "Planned");
  assert.equal(op2?.completed_quantity, 3);
  assert.deepEqual(JSON.parse(String(op2?.quantity_ledger)), [
    { userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 3 },
  ]);
  assert.equal(changes.some((change) => change.id === 12), false);
  assert.equal(changes.find((change) => change.entity === "requirements")?.patch.status, "Ready for Manufacturing");
});

test("QC failure defaults to the full quantity and validates its reason and quantity", async () => {
  const complete = () => fixture({
    operation: {
      Status: { value: "Complete" }, "Completed Quantity": 2,
      "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      "Completed At": "2026-09-05T12:00:00Z",
    },
    requirement: { Status: { value: "Ready for QC" } },
  });
  const defaulted = harness(complete());
  await defaulted.adapter.recordQualityReview(20, "failed", "Surface finish", ACTOR);
  assert.equal((defaulted.commits[0].p_qc as Record<string, unknown>).rejected_quantity, 2);
  const operationPatch = (defaulted.commits[0].p_changes as Array<{ entity: string; patch: Record<string, unknown> }>).find((change) => change.entity === "operations")?.patch;
  assert.equal(operationPatch?.completed_quantity, 0);
  assert.equal(operationPatch?.status, "Ready");

  await assert.rejects(async () => harness(complete()).adapter.recordQualityReview(20, "failed", "   ", ACTOR), /reason/);
  await assert.rejects(async () => harness(complete()).adapter.recordQualityReview(20, "failed", "Bad", ACTOR, null, 3), /from 1 to 2/);
});

test("part locations are editable before QC while On Robot requires passed QC and completed finishing", async () => {
  const reviewedAt = "2026-09-05T13:00:00Z";
  const passedState = fixture({
    operation: {
      Status: { value: "Complete" }, "Completed Quantity": 2,
      "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      "Completed At": "2026-09-05T12:00:00Z",
    },
    requirement: { "QC Outcome": { value: "Passed" }, Status: { value: "Complete" } },
    reviews: [{ id: 50, production_requirement_id: 20, operation_id: null, result: "passed", reviewed_at: reviewedAt }],
  });
  const changed = harness(fixture());
  const changedResult = await changed.adapter.updatePartLocation(20, "Kwolek 2-8", ACTOR);
  assert.equal(changedResult.storageLocation, "Kwolek 2-8");
  assert.equal(changedResult.notificationContext.previousLocation, null);
  assert.equal(changed.commits[0].p_action, "part_location");
  assert.equal((changed.commits[0].p_qc as { location: string }).location, "Kwolek 2-8");
  assert.deepEqual(changed.commits[0].p_changes, []);

  const cleared = harness(fixture());
  const clearedResult = await cleared.adapter.updatePartLocation(20, null, ACTOR);
  assert.equal(clearedResult.storageLocation, null);
  assert.equal((cleared.commits[0].p_qc as { location: null }).location, null);

  const onRobot = harness(passedState);
  assert.equal((await onRobot.adapter.updatePartLocation(20, "On Robot", ACTOR)).storageLocation, "On Robot");

  const withoutQc = harness(fixture());
  await assert.rejects(withoutQc.adapter.updatePartLocation(20, "On Robot", ACTOR), /passed QC review/);
  assert.equal(withoutQc.commits.length, 0);

  const awaitingFinishing = harness(fixture({
    operation: runtimeRow(ENTITIES.find(entity => entity.name === "operations")!, passedState.rows.operations[0]),
    requirement: { "QC Outcome": { value: "Passed" }, Finishing: { value: "Black" }, Status: { value: "Ready for Finishing" } },
    reviews: passedState.reviews,
  }));
  await assert.rejects(awaitingFinishing.adapter.updatePartLocation(20, "On Robot", ACTOR), /Complete finishing/);
  assert.equal(awaitingFinishing.commits.length, 0);

});

test("passed QC inspection notes can be revised without changing workflow status or location", async () => {
  const reviewedAt = "2026-09-05T13:00:00Z";
  const state = fixture({
    operation: {
      Status: { value: "Complete" }, "Completed Quantity": 2, "Completed At": "2026-09-05T12:00:00Z",
      "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
    },
    requirement: {
      Status: { value: "Complete" }, "QC Outcome": { value: "Passed" }, "QC Notes": "Original note",
      "QC Reviewed By": "Robin R.", "QC Reviewed At": reviewedAt,
    },
    reviews: [{ id: 50, production_requirement_id: 20, operation_id: null, result: "passed", reviewed_at: reviewedAt }],
  });
  state.rows.requirements[0].part_location = "Clarke 1";
  const qc = harness(state);

  const result = await qc.adapter.updatePassedQualityNotes(20, "Updated measurement", ACTOR);

  assert.equal(result.notes, "Updated measurement");
  assert.equal(qc.commits[0].p_action, "qc_review");
  assert.deepEqual(qc.commits[0].p_qc, {
    requirement_id: 20,
    result: "passed",
    notes: "Updated measurement",
    reviewed_at: result.reviewedAt,
    location: null,
  });
  const changes = qc.commits[0].p_changes as Array<{ entity: string; patch: Record<string, unknown> }>;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].entity, "requirements");
  assert.equal(changes[0].patch.qc_notes, "Updated measurement");
  assert.equal(changes[0].patch.qc_reviewed_by, ACTOR.name);
  assert.equal(changes[0].patch.status, undefined);
  assert.equal(changes[0].patch.part_location, undefined);
});

test("QC and finishing cannot be reopened while the part is on the robot", async () => {
  const reviewedAt = "2026-09-05T13:00:00Z";
  const qcState = fixture({
    operation: {
      Status: { value: "Complete" }, "Completed Quantity": 2,
      "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      "Completed At": "2026-09-05T12:00:00Z",
    },
    requirement: { "QC Outcome": { value: "Passed" }, Status: { value: "Complete" } },
    reviews: [{ id: 50, production_requirement_id: 20, operation_id: null, result: "passed", reviewed_at: reviewedAt }],
  });
  qcState.rows.requirements[0].part_location = "On Robot";
  const qc = harness(qcState);
  await assert.rejects(qc.adapter.undoQualityReview(20, ACTOR), /Move the part off the robot/);
  assert.equal(qc.commits.length, 0);

  const finishingState = fixture({
    requirement: { "QC Outcome": { value: "Passed" }, Finishing: { value: "Black" }, Status: { value: "Complete" } },
    finishing: { Machinist: ACTOR.name },
  });
  finishingState.rows.requirements[0].part_location = "On Robot";
  const finishing = harness(finishingState);
  await assert.rejects(finishing.adapter.applyFabricationAction(30, "undo_complete", ACTOR), /Move the part off the robot/);
  assert.equal(finishing.commits.length, 0);
});

test("QC releases threaded inserts only after any required finishing completes", async () => {
  const readyForQc = withThreadedInsert(fixture({
    operation: {
      Status: { value: "Complete" }, "Completed Quantity": 2,
      "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      "Completed At": "2026-09-05T12:00:00Z",
    },
    requirement: { Status: { value: "Ready for QC" }, "QC Outcome": { value: "Not Inspected" } },
  }));
  const uncoated = harness(readyForQc);
  await uncoated.adapter.recordQualityReview(20, "passed", "Primary work accepted", ACTOR);
  const uncoatedChanges = uncoated.commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  assert.equal(uncoatedChanges.find(({ entity, id }) => entity === "operations" && id === 11)?.patch.status, "Ready");
  assert.equal(uncoatedChanges.find(({ entity }) => entity === "requirements")?.patch.status, "Ready for Manufacturing");

  const coatedState = withThreadedInsert(fixture({
    operation: runtimeRow(ENTITIES.find(entity => entity.name === "operations")!, readyForQc.rows.operations[0]),
    requirement: {
      Status: { value: "Ready for Finishing" }, Finishing: { value: "Black" },
      "QC Outcome": { value: "Passed" },
    },
    finishing: { Machinist: ACTOR.name },
  }));
  const coated = harness(coatedState);
  const result = await coated.adapter.applyFabricationAction(30, "complete", ACTOR);
  assert.equal(result.status, "Complete");
  assert.equal(result.requirementStatus, "Ready for Manufacturing");
  const coatedChanges = coated.commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  assert.equal(coatedChanges.find(({ entity, id }) => entity === "operations" && id === 11)?.patch.status, "Ready");
});

test("threaded inserts cannot be claimed before QC even if a stale row says Ready", async () => {
  const state = withThreadedInsert(fixture(), { Status: { value: "Ready" } });
  const { adapter, commits } = harness(state);
  await assert.rejects(adapter.applyQuantityAction(11, "claim", 1, ACTOR), /passed QC review/);
  assert.equal(commits.length, 0);
});

test("release, completion undo, CAM edits, finishing completion, and QC undo are planned safely", async () => {
  const claimedState = fixture({ operation: {
    Status: { value: "In Progress" }, Machinist: "Alex A. (1)", "Claimed Quantity": 1,
    "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 1, completed: 0 }]),
    "Started At": "2026-09-05T00:00:00Z",
  }});
  const release = harness(claimedState);
  const released = await release.adapter.applyQuantityAction(10, "release", 1, ACTOR);
  assert.equal(released.status, "Ready");
  assert.equal(release.commits[0].p_action, "release");

  const completeState = fixture({ operation: {
    Status: { value: "Complete" }, Machinist: "Alex A. (2)", "Completed Quantity": 2,
    "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
    "Started At": "2026-09-05T00:00:00Z", "Completed At": "2026-09-05T00:01:00Z",
  }, requirement: { Status: { value: "Ready for QC" }, Machinist: "Alex A. (2)" } });
  const undo = harness(completeState);
  const undone = await undo.adapter.applyQuantityAction(10, "undo_complete", 1, ACTOR);
  assert.equal(undone.status, "In Progress");
  assert.equal(undone.claimedQuantity, 1);
  assert.equal(undone.completedQuantity, 1);
  assert.equal(undo.commits[0].p_action, "undo_complete");

  const camState = fixture({ operation: {
    Operation: "fixture|OP1|CAM", Machine: { value: "Haas" }, "Work Type": { value: "CAM" },
    Status: { value: "Complete" }, Machinist: "Alex A.", "Completed Quantity": 1,
    "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 1 }]),
    "Completed At": "2026-09-05T00:01:00Z",
  }});
  const camEdit = harness(camState);
  const edited = await camEdit.adapter.updateCamHandoff(10, { completedBy: "Blake B.", programPath: "new.nc", notes: "Updated" }, ACTOR);
  assert.equal(edited.machinist, "Blake B.");
  assert.equal(camEdit.commits[0].p_action, "cam_handoff");

  const finishingComplete = harness(fixture({
    requirement: { Status: { value: "Ready for Finishing" }, Finishing: { value: "Black" } },
    finishing: { Machinist: ACTOR.name },
  }));
  const finished = await finishingComplete.adapter.applyFabricationAction(30, "complete", ACTOR);
  assert.equal(finished.requirementStatus, "Complete");
  assert.equal(finishingComplete.commits[0].p_action, "finishing_complete");

  const finishingUndo = harness(fixture({
    requirement: { Status: { value: "Complete" }, Finishing: { value: "Black" } },
    finishing: { Machinist: ACTOR.name },
  }));
  const reopened = await finishingUndo.adapter.applyFabricationAction(30, "undo_complete", ACTOR);
  assert.equal(reopened.requirementStatus, "Ready for Finishing");
  assert.equal(finishingUndo.commits[0].p_action, "finishing_undo_complete");

  const passedAt = "2026-09-05T00:02:00Z";
  const qcUndo = harness(fixture({
    operation: {
      Status: { value: "Complete" }, Machinist: "Alex A. (2)", "Completed Quantity": 2,
      "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      "Completed At": "2026-09-05T00:01:00Z",
    },
    requirement: {
      Status: { value: "Complete" }, Machinist: "Alex A. (2)", "QC Outcome": { value: "Passed" },
      "QC Notes": "Looks good", "QC Reviewed By": ACTOR.name, "QC Reviewed At": passedAt,
    },
    reviews: [{ id: 50, production_requirement_id: 20, operation_id: null, result: "passed", reviewed_at: passedAt }],
  }));
  const reviewUndoResult = await qcUndo.adapter.undoQualityReview(20, ACTOR);
  assert.deepEqual(reviewUndoResult, {
    undone: true,
    requirementId: 20,
    notificationContext: {
      requirementId: 20,
      partNumber: "P-1",
      partName: "Fixture",
      assemblyNumber: "A-1",
    },
  });
  assert.equal(qcUndo.commits[0].p_action, "qc_undo");
  assert.deepEqual(qcUndo.commits[0].p_qc, { requirement_id: 20 });
});

test("stale edits become 409 responses and transport retries reuse the request ID", async () => {
  const stale = harness(fixture(), () => Response.json({ code: "40001", message: "changed" }, { status: 400 }));
  await assert.rejects(
    stale.adapter.applyQuantityAction(10, "claim", 1, ACTOR),
    (error: unknown) => error instanceof ManufacturingWriteError && error.status === 409,
  );

  const retry = harness(fixture(), (body, attempt) => {
    if (attempt === 1) throw new TypeError("connection reset after commit");
    return Response.json(body.p_result);
  });
  await retry.adapter.applyQuantityAction(10, "claim", 1, ACTOR);
  assert.equal(retry.commits.length, 2);
  assert.equal(retry.commits[0].p_request_id, retry.commits[1].p_request_id);
  assert.deepEqual(retry.commits[0], retry.commits[1]);
});

test("Supabase writes reject demo and missing identities before reading state", async () => {
  let called = false;
  const adapter = createSupabaseWriteAdapter({
    url: "https://example.test",
    serviceKey: "test-service-key",
    fetch: async () => { called = true; return Response.json({}); },
  });
  await assert.rejects(
    adapter.applyQuantityAction(10, "claim", 1, { id: "demo-admin", name: "Demo Machinist" }),
    (error: unknown) => error instanceof ManufacturingWriteError && error.status === 401,
  );
  assert.equal(called, false);
});

test("obsolete requirements block every work mutation while notes and off-robot locations remain editable", async () => {
  const state = fixture();
  state.rows.requirements[0].obsolete = true;
  const { adapter, commits } = harness(state);
  const actions = [
    () => adapter.applyQuantityAction(10, "claim", 1, ACTOR),
    () => adapter.applyQuantityAction(10, "release", 1, ACTOR),
    () => adapter.applyQuantityAction(10, "complete", 1, ACTOR),
    () => adapter.applyQuantityAction(10, "undo_complete", 1, ACTOR),
    () => adapter.stealOperationClaim(10, ACTOR),
    () => adapter.patchOperation(10, { status: "Blocked" }, ACTOR),
    () => adapter.updateCamHandoff(10, { completedBy: "Alex", programPath: "", notes: "" }, ACTOR),
    () => adapter.applyFabricationAction(30, "claim", ACTOR),
    () => adapter.applyFabricationAction(30, "complete", ACTOR),
    () => adapter.applyFabricationAction(30, "release", ACTOR),
    () => adapter.applyFabricationAction(30, "undo_complete", ACTOR),
    () => adapter.recordQualityReview(20, "passed", "", ACTOR),
    () => adapter.recordQualityReview(20, "failed", "Defect", ACTOR),
    () => adapter.undoQualityReview(20, ACTOR),
    () => adapter.previewForceQuality(20),
    () => adapter.forceQualityReview(20, "", state.token, ACTOR),
    () => adapter.updatePartLocation(20, "On Robot", ACTOR),
  ];
  for (const action of actions) await assert.rejects(action, error => error instanceof ManufacturingWriteError && error.status === 409 && /obsolete/.test(error.message));
  assert.equal(commits.length, 0);
  await adapter.updateRequirementNotes(20, "Remove from robot", ACTOR);
  await adapter.updatePartLocation(20, "Shelf 1", ACTOR);
  assert.equal(commits.length, 2);
});

test("obsoletion uses the displayed version, database snapshot, and an idempotent request ID", async () => {
  const state = fixture();
  state.rows.requirements[0].obsoletion_version = 4;
  const original = structuredClone(state);
  const retry = harness(state, (body, attempt) => {
    if (attempt === 1) throw new TypeError("Lost response");
    return Response.json({ requirementId: 20, obsolete: body.p_obsolete, obsoletionVersion: 5 });
  });
  await assert.rejects(retry.adapter.setRequirementObsolete(20, false, 3, ACTOR), /Obsoletion changed/);
  assert.equal(retry.commits.length, 0);
  const result = await retry.adapter.setRequirementObsolete(20, true, 4, ACTOR);
  assert.equal(result.obsolete, true);
  assert.equal(result.obsoletionVersion, 5);
  assert.equal(result.notificationContext.partNumber, "P-1");
  assert.equal(result.notificationContext.partName, "Fixture");
  assert.equal(result.notificationContext.assemblyNumber, "A-1");
  assert.equal(result.notificationContext.previousObsolete, false);
  assert.equal(retry.commits.length, 2);
  assert.deepEqual(retry.commits[0], retry.commits[1]);
  assert.equal(retry.commits[0].p_expected, state.token);
  assert.deepEqual(state, original);
  const denied = harness(state, () => Response.json({ code: "42501" }, { status: 403 }));
  await assert.rejects(denied.adapter.setRequirementObsolete(20, true, 4, ACTOR), error => error instanceof ManufacturingWriteError && error.status === 403);
});

test("restoration and Undo return the previous flag and installation context for Slack", async () => {
  for (const previousObsolete of [true, false]) {
    const state = fixture();
    Object.assign(state.rows.requirements[0], { obsolete: previousObsolete, obsoletion_version: 4, required_part_revision: "B", part_location: "On Robot" });
    const { adapter } = harness(state, body => Response.json({ requirementId: 20, obsolete: body.p_obsolete, obsoletionVersion: 5 }));
    const result = await adapter.setRequirementObsolete(20, !previousObsolete, 4, ACTOR);
    assert.equal(result.notificationContext.previousObsolete, previousObsolete);
    assert.equal(result.notificationContext.revision, "B");
    assert.equal(result.notificationContext.location, "On Robot");
    assert.equal(result.obsolete, !previousObsolete);
  }
});


test("visibility writes validate obsolete/version and retry the identical transaction", async () => {
  const state=fixture();
  const { adapter, commits }=harness(state, (body,attempt)=>{
    if(attempt===1) throw new TypeError("Lost response");
    return Response.json({requirementId:20,hidden:body.p_hidden,visibilityVersion:1});
  });
  await assert.rejects(adapter.setRequirementHidden(20,true,0,ACTOR),/Only obsolete/);
  assert.equal(commits.length,0);
  state.rows.requirements[0].obsolete=true;
  await assert.rejects(adapter.setRequirementHidden(20,true,1,ACTOR),/Visibility changed/);
  const result=await adapter.setRequirementHidden(20,true,0,ACTOR);
  assert.equal(result.hidden,true);
  assert.equal(result.visibilityVersion,1);
  assert.deepEqual(commits[0],commits[1]);
  const denied=harness(state,()=>Response.json({code:"42501"},{status:403}));
  await assert.rejects(denied.adapter.setRequirementHidden(20,true,0,ACTOR),error=>error instanceof ManufacturingWriteError && error.status===403);
});
