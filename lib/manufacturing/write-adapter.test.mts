import test from "node:test";
import assert from "node:assert/strict";

import { ENTITIES, normalizeRow, type NormalizedRow, type RawRow } from "./model.ts";
import { createSupabaseWriteAdapter, ManufacturingWriteError, type WriteState } from "./write-adapter.ts";

const ACTOR = { id: "00000000-0000-4000-8000-000000000190", name: "Alex A." };

function normalized(entityName: string, raw: RawRow): NormalizedRow {
  const entity = ENTITIES.find((candidate) => candidate.name === entityName);
  assert.ok(entity);
  return normalizeRow(entity, raw) as NormalizedRow;
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
    rows: { operations: [operation], requirements: [requirement], finishing: [finishing] },
    reviews: options.reviews ?? [],
    retractions: options.retractions ?? [],
  };
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
      assert.ok(String(input).endsWith("/manufacturing_commit_with_locations"));
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
  await qc.adapter.recordQualityReview(20, "passed", "Looks good", ACTOR, "Clarke 1");
  assert.equal(qc.commits[0].p_action, "qc_review");
  assert.equal((qc.commits[0].p_qc as { result: string }).result, "passed");
  assert.equal((qc.commits[0].p_qc as { location: string }).location, "Clarke 1");
  assert.equal((qc.commits[0].p_changes as Array<{ entity: string }>).length, 1);
});

test("QC locations can be changed or cleared only for an effective passed review", async () => {
  const reviewedAt = "2026-09-05T13:00:00Z";
  const passedState = fixture({
    operation: {
      Status: { value: "Complete" }, "Completed Quantity": 2,
      "Quantity Ledger": JSON.stringify([{ userId: ACTOR.id, name: ACTOR.name, claimed: 0, completed: 2 }]),
      "Completed At": "2026-09-05T12:00:00Z",
    },
    reviews: [{ id: 50, production_requirement_id: 20, operation_id: null, result: "passed", reviewed_at: reviewedAt }],
  });
  const changed = harness(passedState);
  const changedResult = await changed.adapter.updateQualityLocation(20, "Kwolek 2-8", ACTOR);
  assert.equal(changedResult.storageLocation, "Kwolek 2-8");
  assert.equal(changed.commits[0].p_action, "qc_location");
  assert.equal((changed.commits[0].p_qc as { location: string }).location, "Kwolek 2-8");
  assert.deepEqual(changed.commits[0].p_changes, []);

  const cleared = harness(passedState);
  const clearedResult = await cleared.adapter.updateQualityLocation(20, null, ACTOR);
  assert.equal(clearedResult.storageLocation, null);
  assert.equal((cleared.commits[0].p_qc as { location: null }).location, null);

  const invalidStates = [
    fixture({ operation: passedState.rows.operations[0], reviews: [] }),
    fixture({ operation: passedState.rows.operations[0], reviews: [{ id: 50, production_requirement_id: 20, operation_id: null, result: "failed", reviewed_at: reviewedAt }] }),
    fixture({ operation: { ...passedState.rows.operations[0], "Completed At": "2026-09-05T14:00:00Z" }, reviews: passedState.reviews }),
    fixture({ operation: passedState.rows.operations[0], reviews: passedState.reviews, retractions: [{ review_id: 50 }] }),
  ];
  for (const state of invalidStates) {
    const invalid = harness(state);
    await assert.rejects(
      invalid.adapter.updateQualityLocation(20, "Shelf 3", ACTOR),
      (error: unknown) => error instanceof ManufacturingWriteError && error.status === 409,
    );
    assert.equal(invalid.commits.length, 0);
  }
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
  assert.deepEqual(reviewUndoResult, { undone: true, requirementId: 20 });
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
