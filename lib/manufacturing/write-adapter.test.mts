import test from "node:test";
import assert from "node:assert/strict";

import type { NormalizedRow } from "./model.ts";
import { createSupabaseWriteAdapter, ManufacturingWriteError, type WriteState } from "./write-adapter.ts";
import { formatSlackManufacturingEvent } from "../slack-notifications-core.ts";

const ACTOR = { id: "00000000-0000-4000-8000-000000000190", name: "Alex A." };

test("native CAM claims resolve current identities, not stale Baserow source rows", async () => {
  const state = fixture({ operation: { work_type: "CAM" } });
  for (const records of Object.values(state.rows)) for (const row of records) {
    row.source_row = { id: row.id,
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
    status: "In Progress", completed_quantity: 1, claimed_quantity: 1,
    quantity_ledger: JSON.stringify([{ userId: "other", name: "Other", claimed: 1, completed: 1 }]),
  } });
  state.rows.operations.push({
    id: 12, operation_key: "fixture|OP1|CAM", requirement_id: 20,
    operation_number: "OP1", work_type: "CAM", active_in_routing: true,
    status: "Planned", cam_program_path: "existing.nc", cam_notes: "Keep this",
  });
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
    status: "In Progress", completed_quantity: 1, claimed_quantity: 1,
    quantity_ledger: JSON.stringify([{ userId: "other", name: "Other", claimed: 1, completed: 1 }]),
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
  // The commit RPC rejects a failed review without a whole-number rejected quantity.
  assert.equal(qc.rejected_quantity, 2);
  assert.equal(review.rejectedQuantity, 2);
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

test("Force QC failure requires a reason and passes send no rejected quantity", async () => {
  const blank = harness(fixture());
  const preview = await blank.adapter.previewForceQuality(20);
  await assert.rejects(blank.adapter.forceQualityReview(20, "   ", preview.token, ACTOR, "failed"),
    (error) => error instanceof ManufacturingWriteError && error.status === 400 && /reason/.test(error.message));
  assert.equal(blank.commits.length, 0);

  const passed = harness(fixture());
  const review = await passed.adapter.forceQualityReview(20, "", (await passed.adapter.previewForceQuality(20)).token, ACTOR);
  assert.equal(review.rejectedQuantity, null);
  assert.equal("rejected_quantity" in (passed.commits[0].p_qc as Record<string, unknown>), false);
});

test("Force QC refuses to fail a batch whose required quantity is not finite", async () => {
  // to_jsonb writes numeric NaN as the string "NaN".
  const { adapter, commits } = harness(fixture({ requirement: { required_quantity: "NaN" } }));
  const preview = await adapter.previewForceQuality(20);
  await assert.rejects(adapter.forceQualityReview(20, "Rejected batch", preview.token, ACTOR, "failed"),
    (error) => error instanceof ManufacturingWriteError && error.status === 409
      && error.message === "Rejected quantity must be a whole number from 1 to NaN");
  assert.equal(commits.length, 0);
});

test("workflow rule violations are conflicts and invalid CAM quantities are bad requests", async () => {
  const claimed = harness(fixture());
  await assert.rejects(claimed.adapter.applyQuantityAction(10, "claim", 3, ACTOR),
    (error) => error instanceof ManufacturingWriteError && error.status === 409 && /Only 2 part\(s\) remain available/.test(error.message));
  const cam = harness(fixture({ operation: { work_type: "CAM" } }));
  await assert.rejects(cam.adapter.applyQuantityAction(10, "claim", 2, ACTOR),
    (error) => error instanceof ManufacturingWriteError && error.status === 400 && /single task/.test(error.message));

  const prints = harness(fixture({ operation: {
    machine: "Bambu 3D Printer", status: "In Progress", claimed_quantity: 1,
    quantity_ledger: JSON.stringify([{ userId: "other", name: "Other", claimed: 1, completed: 0 }]),
  } }));
  await assert.rejects(prints.adapter.applyQuantityAction(10, "complete", 2, ACTOR, { completeAllClaims: true }),
    (error) => error instanceof ManufacturingWriteError && error.status === 409 && /print claims changed/.test(error.message));

  const camState = fixture({ operation: {
    work_type: "CAM", status: "Complete", completed_quantity: 1,
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 1 }]),
  } });
  camState.rows.operations.push({
    id: 13, operation_key: "fixture|OP1|Manufacturing", requirement_id: 20,
    operation_number: "OP1", machine: "Haas CNC", work_type: "Manufacturing",
    active_in_routing: true, status: "In Progress", claimed_quantity: 1,
    quantity_ledger: JSON.stringify([{ userId: "other", name: "Other", claimed: 1, completed: 0 }]),
  });
  const reopenCam = harness(camState);
  await assert.rejects(reopenCam.adapter.applyQuantityAction(10, "undo_complete", 1, ACTOR),
    (error) => error instanceof ManufacturingWriteError && error.status === 409 && /cannot be reopened/.test(error.message));

  // Unparseable and malformed ledgers get the same reconciliation message, not a parser error.
  const corrupt = harness(fixture({ operation: { claimed_quantity: 1, quantity_ledger: "{not json" } }));
  await assert.rejects(corrupt.adapter.applyQuantityAction(10, "claim", 1, ACTOR),
    (error) => error instanceof ManufacturingWriteError && error.status === 409 && /reconciliation is required/.test(error.message));
  assert.equal(claimed.commits.length + cam.commits.length + prints.commits.length + reopenCam.commits.length + corrupt.commits.length, 0);
});

test("Force QC routes finishing and post-QC work without completing inserts", async () => {
  for (const finishing of ["None", "Black"]) {
    const state = withThreadedInsert(fixture({ requirement: { finishing } }));
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

test("Force QC can complete finishing in the same passed review", async () => {
  for (const postQcWork of [false, true]) {
    const base = fixture({ requirement: { finishing: "Black" }, finishing: { machinist: "Other" } });
    const { adapter, commits } = harness(postQcWork ? withThreadedInsert(base) : base);
    const preview = await adapter.previewForceQuality(20);
    const review = await adapter.forceQualityReview(20, "Finished", preview.token, ACTOR, "passed", true);
    assert.equal(review.finishingCompleted, true);
    assert.equal(review.notificationContext.requirementStatus, postQcWork ? "Ready for Manufacturing" : "Complete");
    assert.equal(commits.length, 1);
    assert.equal(commits[0].p_action, "qc_review");
    const changes = commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
    assert.equal(changes.find(change => change.entity === "finishing")!.patch.machinist, ACTOR.name);
    // The fixture starts in Ready for Manufacturing, so post-QC work leaves status unpatched.
    assert.equal(changes.find(change => change.entity === "requirements")!.patch.status, postQcWork ? undefined : "Complete");
    if (postQcWork) assert.equal(changes.find(change => change.entity === "operations" && change.id === 11)!.patch.status, "Ready");
  }
  // Without finishing, the option is a no-op.
  const plain = harness(fixture());
  const plainPreview = await plain.adapter.previewForceQuality(20);
  assert.equal((await plain.adapter.forceQualityReview(20, "", plainPreview.token, ACTOR, "passed", true)).finishingCompleted, false);
  const failing = harness(fixture({ requirement: { finishing: "Black" } }));
  await assert.rejects(failing.adapter.forceQualityReview(20, "", "fixture-token", ACTOR, "failed", true), /only be completed when QC passes/);
  assert.equal(failing.commits.length, 0);
});

test("Force QC rejects stale previews, inactive requirements, completed prerequisites, and current passes", async () => {
  const stale = harness(fixture());
  await assert.rejects(stale.adapter.forceQualityReview(20, "", "old-token", ACTOR), /Refresh the preview/);
  assert.equal(stale.commits.length, 0);
  const inactive = harness(fixture({ requirement: { active_in_bom: false } }));
  await assert.rejects(inactive.adapter.previewForceQuality(20), /inactive/);
  const complete = harness(fixture({ operation: { status: "Complete", completed_quantity: 2 } }));
  await assert.rejects(complete.adapter.previewForceQuality(20), /normal QC/);
  const passed = harness(fixture({ operation: { status: "Complete", completed_quantity: 2 }, reviews: [{
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
  const state = fixture({ operation: { status: "Needs Rework" }, requirement: { qc_outcome: "Failed" } });
  const original = structuredClone(state);
  const denied = harness(state, () => Response.json({ code: "42501" }, { status: 403 }));
  const preview = await denied.adapter.previewForceQuality(20);
  assert.equal(preview.operations[0].previousStatus, "Ready");
  await assert.rejects(denied.adapter.forceQualityReview(20, "Rework inspected", preview.token, ACTOR), error => error instanceof ManufacturingWriteError && error.status === 403);
  assert.equal(denied.commits.length, 1);
  assert.deepEqual(state, original);
});

function fixture(options: {
  operation?: Partial<NormalizedRow>;
  requirement?: Partial<NormalizedRow>;
  finishing?: Partial<NormalizedRow>;
  reviews?: Array<Pick<WriteState["reviews"][number], "id" | "production_requirement_id" | "operation_id" | "result" | "reviewed_at">>;
  retractions?: WriteState["retractions"];
} = {}): WriteState {
  const requirement = {
    id: 20,
    production_key: "fixture",
    part_id: 40, assembly_id: 50,
    required_quantity: 2,
    finishing: "None",
    active_in_bom: true,
    status: "Ready for Manufacturing",
    machinist: "",
    qc_outcome: "Not Inspected",
    qc_notes: "",
    qc_reviewed_by: "",
    ...options.requirement,
  };
  const operation = {
    id: 10,
    operation_key: "fixture|OP1|Manufacturing",
    requirement_id: 20,
    operation_number: "OP1",
    machine: "Mill",
    work_type: "Manufacturing",
    active_in_routing: true,
    status: "Ready",
    machinist: "",
    claimed_quantity: 0,
    completed_quantity: 0,
    quantity_ledger: "",
    ...options.operation,
  };
  const finishing = {
    id: 30,
    production_key: "fixture",
    requirement_id: 20,
    active: true,
    machinist: "",
    ...options.finishing,
  };
  return {
    token: "fixture-token",
    rows: { parts: [{ id: 40, part_number: "P-1", name: "Fixture" }], assemblies: [{ id: 50, assembly_number: "A-1" }], operations: [operation], requirements: [requirement], finishing: [finishing] },
    reviews: (options.reviews ?? []).map(review => ({ notes: "", rejected_quantity: null, reviewed_by: ACTOR.id, ...review })),
    retractions: options.retractions ?? [],
  };
}

function withThreadedInsert(state: WriteState, overrides: Partial<NormalizedRow> = {}) {
  state.rows.operations.push({
    id: 11,
    operation_key: "fixture|OP2|Manufacturing",
    requirement_id: 20,
    operation_number: "OP2",
    machine: "Threaded Insert",
    work_type: "Manufacturing",
    active_in_routing: true,
    status: "Planned",
    machinist: "",
    claimed_quantity: 0,
    completed_quantity: 0,
    quantity_ledger: "",
    ...overrides,
  });
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
    postQcWorkReady: false,
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

test("a non-finite engineering quantity on another requirement does not block shop writes", async () => {
  // to_jsonb writes numeric NaN and Infinity as strings; only shop columns are coerced for the commit.
  const state = fixture();
  state.rows.requirements.push({ id: 21, production_key: "broken", part_id: 40, assembly_id: 50, required_quantity: "NaN", finishing: "Anodize", active_in_bom: true, status: "Ready for Manufacturing" });
  state.rows.finishing.push({ id: 31, production_key: "broken", requirement_id: 21, required_quantity: "Infinity", active: true, machinist: "" });
  const { adapter, commits } = harness(state);
  const result = await adapter.applyQuantityAction(10, "claim", 1, ACTOR);
  assert.equal(result.status, "In Progress");
  const changes = commits[0].p_changes as Array<{ entity: string; id: number }>;
  assert.deepEqual(changes.map(({ entity, id }) => ({ entity, id })), [
    { entity: "requirements", id: 20 },
    { entity: "operations", id: 10 },
  ]);
});

test("print claims save their printer in the same transaction and omission leaves location alone", async () => {
  const state = fixture({ operation: { machine: "Bambu 3D Printer" } });
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
    machine: "Bambu 3D Printer", status: "In Progress",
    claimed_quantity: 2, quantity_ledger: JSON.stringify(allocations),
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
    status: "In Progress", claimed_quantity: 2,
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 2, completed: 0 }]),
  } });
  const { adapter, commits } = harness(state);
  const result = await adapter.applyQuantityAction(10, "complete", 2, ACTOR, { location: "Shelf 2" });
  assert.equal(result.storageLocation, "Shelf 2");
  await assert.rejects(adapter.applyQuantityAction(10, "complete", 2, ACTOR, { completeAllClaims: true }), /Only 3D printing/);
  await assert.rejects(adapter.applyQuantityAction(10, "release", 2, ACTOR, { location: "Shelf 2" }), /Set a location/);
  await assert.rejects(adapter.applyQuantityAction(10, "complete", 2, ACTOR, { location: "On Robot" }), /after QC/);
  assert.equal(commits.length, 1);
  const cam = harness(fixture({ operation: { work_type: "CAM" } }));
  await assert.rejects(cam.adapter.applyQuantityAction(10, "claim", 1, ACTOR, { location: "Bambu H2D" }), /Set a location/);
  assert.equal(cam.commits.length, 0);
});

test("print completion and location retry with the identical idempotency payload", async () => {
  const retry = harness(fixture({ operation: { machine: "Bambu 3D Printer" } }), (body, attempt) => {
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
    operation_key: "fixture|OP1|CAM", machine: "Haas", work_type: "CAM",
    status: "In Progress", machinist: "Alex A.", claimed_quantity: 1,
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 1, completed: 0 }]),
  }});
  const cam = harness(camState);
  await cam.adapter.applyQuantityAction(10, "complete", 1, ACTOR, { programPath: "shop/program.nc", notes: "Verified" });
  assert.equal(cam.commits[0].p_action, "complete");
  const camPatch = (cam.commits[0].p_changes as Array<{ entity: string; patch: Record<string, unknown> }>).find((change) => change.entity === "operations")?.patch;
  assert.equal(camPatch?.cam_program_path, "shop/program.nc");
  assert.equal(camPatch?.cam_notes, "Verified");

  const finishing = harness(fixture({ requirement: { status: "Ready for Finishing", finishing: "Black" } }));
  await finishing.adapter.applyFabricationAction(30, "claim", ACTOR);
  assert.equal(finishing.commits[0].p_action, "finishing_claim");
  assert.deepEqual((finishing.commits[0].p_changes as Array<{ entity: string }>).map((change) => change.entity), ["finishing"]);

  const otherId = "00000000-0000-4000-8000-000000000191";
  const steal = harness(fixture({ operation: {
    status: "In Progress", machinist: "Blake B. (2)", claimed_quantity: 2,
    quantity_ledger: JSON.stringify([{ userId: otherId, name: "Blake B.", claimed: 2, completed: 0 }]),
  }}));
  const stolen = await steal.adapter.stealOperationClaim(10, ACTOR);
  assert.deepEqual(stolen.displaced, [{ userId: otherId, name: "Blake B.", quantity: 2 }]);
  assert.equal(steal.commits[0].p_action, "steal");

  const qc = harness(fixture({
    operation: {
      status: "Complete", machinist: "Alex A. (2)", claimed_quantity: 0, completed_quantity: 2,
      quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      completed_at: "2026-09-05T00:00:00Z",
    },
    requirement: { status: "Ready for QC", machinist: "Alex A. (2)" },
  }));
  const qcResult = await qc.adapter.recordQualityReview(20, "passed", "Looks good", ACTOR, "Clarke 1");
  assert.deepEqual(qcResult.notificationContext, {
    requirementId: 20,
    partNumber: "P-1",
    partName: "Fixture",
    assemblyNumber: "A-1",
    previousRequirementStatus: "Ready for QC",
    requirementStatus: "Complete",
    postQcWorkReady: false,
  });
  assert.equal(qc.commits[0].p_action, "qc_review");
  assert.equal((qc.commits[0].p_qc as { result: string }).result, "passed");
  assert.equal((qc.commits[0].p_qc as { location: string }).location, "Clarke 1");
  assert.equal((qc.commits[0].p_changes as Array<{ entity: string }>).length, 1);
});

test("partial QC rejection reopens every physical stage in order and leaves CAM complete", async () => {
  const otherId = "00000000-0000-4000-8000-000000000191";
  const state = fixture({
    requirement: { required_quantity: 5, status: "Ready for QC" },
    operation: {
      status: "Complete", machinist: "Other (2), Alex A. (3)", completed_quantity: 5,
      quantity_ledger: JSON.stringify([
        { userId: otherId, name: "Other", claimed: 0, completed: 2 },
        { userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 3 },
      ]),
      completed_at: "2026-09-05T12:00:00Z",
    },
  });
  state.rows.operations.push({
    id: 11, operation_key: "fixture|OP2|Manufacturing", requirement_id: 20,
    operation_number: "OP2", machine: "Lathe", work_type: "Manufacturing",
    active_in_routing: true, status: "Complete", machinist: "Alex A. (3), Other (2)",
    claimed_quantity: 0, completed_quantity: 5, completed_at: "2026-09-05T13:00:00Z",
    quantity_ledger: JSON.stringify([
      { userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 3 },
      { userId: otherId, name: "Other", claimed: 0, completed: 2 },
    ]),
  });
  state.rows.operations.push({
    id: 12, operation_key: "fixture|OP1|CAM", requirement_id: 20,
    operation_number: "OP1", machine: "Haas CNC", work_type: "CAM",
    active_in_routing: true, status: "Complete", machinist: "Alex A.",
    claimed_quantity: 0, completed_quantity: 1, completed_at: "2026-09-05T11:00:00Z",
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 1 }]),
    cam_program_path: "programs/fixture.nc", cam_notes: "Keep",
  });

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
      status: "Complete", completed_quantity: 2,
      quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      completed_at: "2026-09-05T12:00:00Z",
    },
    requirement: { status: "Ready for QC" },
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
      status: "Complete", completed_quantity: 2,
      quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      completed_at: "2026-09-05T12:00:00Z",
    },
    requirement: { qc_outcome: "Passed", status: "Complete" },
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
    operation: passedState.rows.operations[0],
    requirement: { qc_outcome: "Passed", finishing: "Black", status: "Ready for Finishing" },
    reviews: passedState.reviews,
  }));
  await assert.rejects(awaitingFinishing.adapter.updatePartLocation(20, "On Robot", ACTOR), /Complete finishing/);
  assert.equal(awaitingFinishing.commits.length, 0);

  // Restoring from obsolete leaves the BOM row and routing inactive.
  const historical = fixture({ operation: passedState.rows.operations[0],
    requirement: { qc_outcome: "Passed", status: "Complete" }, reviews: passedState.reviews });
  Object.assign(historical.rows.requirements[0], { active_in_bom: false });
  Object.assign(historical.rows.operations[0], { active_in_routing: false });
  const neverObsoleted = harness(historical);
  await assert.rejects(neverObsoleted.adapter.updatePartLocation(20, "On Robot", ACTOR), /inactive in the BOM/);
  historical.rows.requirements[0].obsoletion_version = 2;
  const restored = harness(historical);
  assert.equal((await restored.adapter.updatePartLocation(20, "On Robot", ACTOR)).storageLocation, "On Robot");
});

test("passed QC inspection notes can be revised without changing workflow status or location", async () => {
  const reviewedAt = "2026-09-05T13:00:00Z";
  const state = fixture({
    operation: {
      status: "Complete", completed_quantity: 2, completed_at: "2026-09-05T12:00:00Z",
      quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
    },
    requirement: {
      status: "Complete", qc_outcome: "Passed", qc_notes: "Original note",
      qc_reviewed_by: "Robin R.", qc_reviewed_at: reviewedAt,
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
      status: "Complete", completed_quantity: 2,
      quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      completed_at: "2026-09-05T12:00:00Z",
    },
    requirement: { qc_outcome: "Passed", status: "Complete" },
    reviews: [{ id: 50, production_requirement_id: 20, operation_id: null, result: "passed", reviewed_at: reviewedAt }],
  });
  qcState.rows.requirements[0].part_location = "On Robot";
  const qc = harness(qcState);
  await assert.rejects(qc.adapter.undoQualityReview(20, ACTOR), /Move the part off the robot/);
  assert.equal(qc.commits.length, 0);

  const finishingState = fixture({
    requirement: { qc_outcome: "Passed", finishing: "Black", status: "Complete" },
    finishing: { machinist: ACTOR.name },
  });
  finishingState.rows.requirements[0].part_location = "On Robot";
  const finishing = harness(finishingState);
  await assert.rejects(finishing.adapter.applyFabricationAction(30, "undo_complete", ACTOR), /Move the part off the robot/);
  assert.equal(finishing.commits.length, 0);
});

test("QC releases threaded inserts only after any required finishing completes", async () => {
  const readyForQc = withThreadedInsert(fixture({
    operation: {
      status: "Complete", completed_quantity: 2,
      quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      completed_at: "2026-09-05T12:00:00Z",
    },
    requirement: { status: "Ready for QC", qc_outcome: "Not Inspected" },
  }));
  const uncoated = harness(readyForQc);
  const uncoatedReview = await uncoated.adapter.recordQualityReview(20, "passed", "Primary work accepted", ACTOR);
  assert.equal(uncoatedReview.notificationContext.postQcWorkReady, true);
  const uncoatedChanges = uncoated.commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  assert.equal(uncoatedChanges.find(({ entity, id }) => entity === "operations" && id === 11)?.patch.status, "Ready");
  assert.equal(uncoatedChanges.find(({ entity }) => entity === "requirements")?.patch.status, "Ready for Manufacturing");

  const coatedState = withThreadedInsert(fixture({
    operation: readyForQc.rows.operations[0],
    requirement: {
      status: "Ready for Finishing", finishing: "Black",
      qc_outcome: "Passed",
    },
    finishing: { machinist: ACTOR.name },
  }));
  const coated = harness(coatedState);
  const result = await coated.adapter.applyFabricationAction(30, "complete", ACTOR);
  assert.equal(result.status, "Complete");
  assert.equal(result.notificationContext.postQcWorkReady, true);
  assert.equal(result.requirementStatus, "Ready for Manufacturing");
  const coatedChanges = coated.commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  assert.equal(coatedChanges.find(({ entity, id }) => entity === "operations" && id === 11)?.patch.status, "Ready");
});

test("post-QC readiness reflects released work, not the requirement status", async () => {
  const completeFirstStage = {
    status: "Complete", completed_quantity: 2, completed_at: "2026-09-05T12:00:00Z",
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
  };
  // Finishing comes first, so a pass releases nothing yet.
  const coated = harness(withThreadedInsert(fixture({ operation: completeFirstStage,
    requirement: { status: "Ready for QC", finishing: "Black" } })));
  assert.equal((await coated.adapter.recordQualityReview(20, "passed", "", ACTOR)).notificationContext.postQcWorkReady, false);

  // A failure reopens the route and never releases post-QC work.
  const failed = harness(withThreadedInsert(fixture({ operation: completeFirstStage, requirement: { status: "Ready for QC" } })));
  assert.equal((await failed.adapter.recordQualityReview(20, "failed", "Bad bore", ACTOR)).notificationContext.postQcWorkReady, false);

  // QC after OP1 with a Haas OP2: the requirement can say Ready for Manufacturing while OP2 still waits on CAM.
  const camGated = fixture({ operation: completeFirstStage, requirement: { status: "Ready for QC" } });
  camGated.rows.requirements[0].qc_after_operation = 1;
  camGated.rows.operations.push(
    { id: 11, operation_key: "fixture|OP2|Manufacturing", requirement_id: 20,
      operation_number: "OP2", machine: "Haas CNC", work_type: "Manufacturing",
      active_in_routing: true, status: "Planned" },
    { id: 12, operation_key: "fixture|OP2|CAM", requirement_id: 20,
      operation_number: "OP2", work_type: "CAM", active_in_routing: true, status: "Ready" },
  );
  const gated = harness(camGated);
  const gatedReview = await gated.adapter.recordQualityReview(20, "passed", "", ACTOR);
  assert.equal(gatedReview.notificationContext.requirementStatus, "Ready for Manufacturing");
  assert.equal(gatedReview.notificationContext.postQcWorkReady, false);

  // A forced pass from unstarted pre-QC work still announces the released inserts.
  const forced = harness(withThreadedInsert(fixture()));
  const review = await forced.adapter.forceQualityReview(20, "", (await forced.adapter.previewForceQuality(20)).token, ACTOR);
  assert.equal(review.notificationContext.previousRequirementStatus, "Ready for Manufacturing");
  assert.equal(review.notificationContext.requirementStatus, "Ready for Manufacturing");
  assert.equal(review.notificationContext.postQcWorkReady, true);
});

test("post-QC readiness covers stale Ready rows and CAM completion that releases gated work", async () => {
  const completeFirstStage = {
    status: "Complete", completed_quantity: 2, completed_at: "2026-09-05T12:00:00Z",
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
  };
  // The insert row already says Ready, but QC is what makes it claimable.
  const stale = harness(withThreadedInsert(fixture({ operation: completeFirstStage, requirement: { status: "Ready for QC" } }),
    { status: "Ready" }));
  assert.equal((await stale.adapter.recordQualityReview(20, "passed", "", ACTOR)).notificationContext.postQcWorkReady, true);

  // QC passed after OP1; completing the CAM for the Haas OP2 is what releases it.
  const gated = fixture({ operation: completeFirstStage,
    requirement: { status: "Ready for Manufacturing", qc_outcome: "Passed" } });
  gated.rows.requirements[0].qc_after_operation = 1;
  gated.rows.operations.push(
    { id: 11, operation_key: "fixture|OP2|Manufacturing", requirement_id: 20,
      operation_number: "OP2", machine: "Haas CNC", work_type: "Manufacturing",
      active_in_routing: true, status: "Planned" },
    { id: 12, operation_key: "fixture|OP2|CAM", requirement_id: 20,
      operation_number: "OP2", work_type: "CAM", active_in_routing: true, status: "In Progress",
      claimed_quantity: 1, quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 1, completed: 0 }]) },
  );
  const cam = harness(gated);
  const completed = await cam.adapter.applyQuantityAction(12, "complete", 1, ACTOR);
  const changes = cam.commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
  assert.equal(changes.find(({ entity, id }) => entity === "operations" && id === 11)?.patch.status, "Ready");
  assert.equal(completed.notificationContext.postQcWorkReady, true);
});

test("a part with a current QC pass cannot be reviewed again until the pass is undone", async () => {
  const passed = fixture({
    operation: { status: "Complete", completed_quantity: 2, completed_at: "2026-09-05T12:00:00Z",
      quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]) },
    requirement: { status: "Complete", qc_outcome: "Passed" },
    reviews: [{ id: 1, production_requirement_id: 20, operation_id: null, result: "passed", reviewed_at: "2026-09-06T12:00:00Z" }],
  });
  for (const result of ["failed", "passed"] as const) {
    const { adapter, commits } = harness(structuredClone(passed));
    await assert.rejects(adapter.recordQualityReview(20, result, "Stale page", ACTOR),
      (error) => error instanceof ManufacturingWriteError && error.status === 409 && /Undo the pass/.test(error.message));
    assert.equal(commits.length, 0);
  }
});

test("a rename updates the requirement assignment only when the renamed operation set it", async () => {
  const OTHER = { id: "00000000-0000-4000-8000-000000000191", name: "Bea B." };
  const done = (actor: { id: string; name: string }) => ({
    status: "Complete", completed_quantity: 2, machinist: `${actor.name} (2)`,
    quantity_ledger: JSON.stringify([{ userId: actor.id, name: actor.name, claimed: 0, completed: 2 }]),
  });
  const secondStage = (actor: { id: string; name: string }, overrides: Partial<NormalizedRow> = {}) => ({
    id: 11, operation_key: "fixture|OP2|Manufacturing", requirement_id: 20, operation_number: "OP2",
    machine: "Lathe", work_type: "Manufacturing", active_in_routing: true, ...done(actor), ...overrides,
  });
  const requirementPatch = async (state: WriteState) => {
    const { adapter, commits } = harness(state);
    await adapter.renameMachinistAllocations(ACTOR.id, ACTOR.name, "Alexis A.");
    const changes = commits[0].p_changes as Array<{ entity: string; id: number; patch: Record<string, unknown> }>;
    return changes.find(({ entity }) => entity === "requirements")?.patch;
  };

  // OP1 by Alex, OP2 by Bea, who assigned the requirement last: Alex's rename leaves it alone.
  const laterStage = fixture({ operation: done(ACTOR), requirement: { machinist: "Bea B. (2)" } });
  laterStage.rows.operations.push(secondStage(OTHER));
  assert.equal(await requirementPatch(laterStage), undefined);

  // Alex did the CAM, Bea machined the part.
  const cam = fixture({ operation: done(OTHER), requirement: { machinist: "Bea B. (2)" } });
  cam.rows.operations.push(secondStage(ACTOR, { work_type: "CAM", operation_number: "OP1", machine: null,
    completed_quantity: 1, machinist: ACTOR.name,
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 1 }]) }));
  assert.equal(await requirementPatch(cam), undefined);

  // When Alex's operation is the one that set it, the assignment follows the rename.
  const own = fixture({ operation: done(ACTOR), requirement: { machinist: "Alex A. (2)" } });
  assert.deepEqual(await requirementPatch(own), { machinist: "Alexis A. (2)" });
});

test("threaded inserts cannot be claimed before QC even if a stale row says Ready", async () => {
  const state = withThreadedInsert(fixture(), { status: "Ready" });
  const { adapter, commits } = harness(state);
  await assert.rejects(adapter.applyQuantityAction(11, "claim", 1, ACTOR), /passed QC review/);
  assert.equal(commits.length, 0);
});

test("release, completion undo, CAM edits, finishing completion, and QC undo are planned safely", async () => {
  const claimedState = fixture({ operation: {
    status: "In Progress", machinist: "Alex A. (1)", claimed_quantity: 1,
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 1, completed: 0 }]),
    started_at: "2026-09-05T00:00:00Z",
  }});
  const release = harness(claimedState);
  const released = await release.adapter.applyQuantityAction(10, "release", 1, ACTOR);
  assert.equal(released.status, "Ready");
  assert.equal(release.commits[0].p_action, "release");

  const completeState = fixture({ operation: {
    status: "Complete", machinist: "Alex A. (2)", completed_quantity: 2,
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
    started_at: "2026-09-05T00:00:00Z", completed_at: "2026-09-05T00:01:00Z",
  }, requirement: { status: "Ready for QC", machinist: "Alex A. (2)" } });
  const undo = harness(completeState);
  const undone = await undo.adapter.applyQuantityAction(10, "undo_complete", 1, ACTOR);
  assert.equal(undone.status, "In Progress");
  assert.equal(undone.claimedQuantity, 1);
  assert.equal(undone.completedQuantity, 1);
  assert.equal(undo.commits[0].p_action, "undo_complete");

  const camState = fixture({ operation: {
    operation_key: "fixture|OP1|CAM", machine: "Haas", work_type: "CAM",
    status: "Complete", machinist: "Alex A.", completed_quantity: 1,
    quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 1 }]),
    completed_at: "2026-09-05T00:01:00Z",
  }});
  const camEdit = harness(camState);
  const edited = await camEdit.adapter.updateCamHandoff(10, { completedBy: "Blake B.", programPath: "new.nc", notes: "Updated" }, ACTOR);
  assert.equal(edited.machinist, "Blake B.");
  assert.equal(camEdit.commits[0].p_action, "cam_handoff");

  const finishingComplete = harness(fixture({
    requirement: { status: "Ready for Finishing", finishing: "Black" },
    finishing: { machinist: ACTOR.name },
  }));
  const finished = await finishingComplete.adapter.applyFabricationAction(30, "complete", ACTOR);
  assert.equal(finished.requirementStatus, "Complete");
  assert.equal(finishingComplete.commits[0].p_action, "finishing_complete");

  const finishingUndo = harness(fixture({
    requirement: { status: "Complete", finishing: "Black" },
    finishing: { machinist: ACTOR.name },
  }));
  const reopened = await finishingUndo.adapter.applyFabricationAction(30, "undo_complete", ACTOR);
  assert.equal(reopened.requirementStatus, "Ready for Finishing");
  assert.equal(finishingUndo.commits[0].p_action, "finishing_undo_complete");

  const passedAt = "2026-09-05T00:02:00Z";
  const qcUndo = harness(fixture({
    operation: {
      status: "Complete", machinist: "Alex A. (2)", completed_quantity: 2,
      quantity_ledger: JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      completed_at: "2026-09-05T00:01:00Z",
    },
    requirement: {
      status: "Complete", machinist: "Alex A. (2)", qc_outcome: "Passed",
      qc_notes: "Looks good", qc_reviewed_by: ACTOR.name, qc_reviewed_at: passedAt,
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

test("an administrator status override can block work and reports what changed", async () => {
  const { adapter, commits } = harness(fixture());
  const result = await adapter.patchOperation(10, { status: "Blocked", machinist: "Blake B." }, ACTOR);
  assert.deepEqual(result, {
    status: "Blocked",
    machinist: "Blake B.",
    notificationContext: {
      requirementId: 20,
      partNumber: "P-1",
      partName: "Fixture",
      assemblyNumber: "A-1",
      operationNumber: "OP1",
      workType: "Manufacturing",
      machine: "Mill",
      previousOperationStatus: "Ready",
      previousMachinist: "",
      previousRequirementStatus: "Ready for Manufacturing",
      requirementStatus: "Ready for Manufacturing",
    },
  });
  assert.equal(commits[0].p_action, "patch_operation");
  assert.deepEqual(commits[0].p_changes, [
    { entity: "requirements", id: 20, patch: { machinist: "Blake B." } },
    { entity: "operations", id: 10, patch: { status: "Blocked", machinist: "Blake B." } },
  ]);
  await assert.rejects(adapter.patchOperation(10, { status: "Complete" }, ACTOR), /Use quantity actions/);
  assert.equal(commits.length, 1);
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

test("finishing takeover atomically transfers only unfinished assignment", async () => {
  const state = fixture({ requirement: { status: "Ready for Finishing", finishing: "Black" }, finishing: { machinist: "Blake B." } });
  const { adapter, commits } = harness(state);
  const result = await adapter.applyFabricationAction(30, "steal", ACTOR);
  assert.equal(result.machinist, ACTOR.name);
  assert.equal(result.displacedMachinist, "Blake B.");
  assert.equal(result.status, "In Progress");
  assert.equal(result.requirementStatus, "Ready for Finishing");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].p_action, "steal");
  assert.deepEqual(commits[0].p_changes, [{ entity: "finishing", id: 30, patch: { machinist: ACTOR.name } }]);
});

for (const scenario of [
  { name: "unclaimed", status: "Ready for Finishing", machinist: "" },
  { name: "own claim", status: "Ready for Finishing", machinist: "alex a." },
  { name: "complete", status: "Complete", machinist: "Blake B." },
  { name: "upstream", status: "Ready for QC", machinist: "Blake B." },
  { name: "inactive", status: "Ready for Finishing", machinist: "Blake B.", inactive: true },
  { name: "obsolete", status: "Ready for Finishing", machinist: "Blake B.", obsolete: true },
]) {
  test(`finishing takeover rejects ${scenario.name} jobs without writing`, async () => {
    const state = fixture({ requirement: { status: scenario.status }, finishing: { machinist: scenario.machinist, active: !scenario.inactive } });
    if (scenario.obsolete) state.rows.requirements[0].obsolete = true;
    const { adapter, commits } = harness(state);
    await assert.rejects(adapter.applyFabricationAction(30, "steal", ACTOR));
    assert.equal(commits.length, 0);
  });
}
