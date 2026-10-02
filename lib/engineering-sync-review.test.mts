import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApprovedPayload, buildSyncReview, SyncReviewError,
  type ReviewRequirement, type SyncPayload, type SyncReviewState,
} from "./engineering-sync-review.ts";

const ROOT = "A-ROOT";
const key = (part: string, rev = "A") => `${ROOT}|${rev}|${ROOT}|${part}|default|v2`;

function current(id: number, part: string, overrides: Partial<ReviewRequirement> = {}): ReviewRequirement {
  return {
    id, production_key: key(part), part_id: id, part_number: part, assembly_number: ROOT, scope_root: ROOT, source_root: ROOT,
    configuration: "default", required_quantity: 2, bom_positions: "1", onshape_url: "", source_document: "Doc",
    source_assembly_revision: "A", required_part_revision: "A", machine_op1: "Lathe", machine_op2: null, machine_op3: null,
    machine_op4: null, finishing: "None", active_in_bom: true, obsolete: false, status: "Ready for Manufacturing",
    qc_outcome: "Not Inspected", part_location: null, off_the_shelf: false, ...overrides,
  };
}

function incoming(part: string, overrides: Record<string, unknown> = {}) {
  return {
    production_key: key(part), part_number: part, assembly_number: ROOT, source_root: ROOT, source_assembly_revision: "B",
    required_part_revision: "A", configuration: "default", required_quantity: 2, bom_positions: "1", onshape_url: "",
    source_document: "Doc", finishing: "None", machine_op1: "Lathe", machine_op2: null, machine_op3: null, machine_op4: null,
    active_in_bom: true, ...overrides,
  };
}

function state(requirements: ReviewRequirement[], rows: Record<string, unknown>[], extra: Omit<Partial<SyncReviewState>, "payload"> & { payload?: Partial<SyncPayload> } = {}): SyncReviewState {
  const { payload: payloadOverrides, ...rest } = extra;
  const payload: SyncPayload = {
    assemblies: [{ assembly_number: ROOT, latest_released_revision: "B", sync_schema_version: "supabase-engineering-v2" }],
    parts: rows.map((row) => ({ part_number: row.part_number, name: String(row.part_number) })),
    requirements: rows,
    operations: rows.flatMap((row) => row.machine_op1 ? [{ operation_key: `${row.production_key}|OP1`, production_key: row.production_key,
      operation_number: "OP1", machine: row.machine_op1, active_in_routing: true, work_type: "Manufacturing" }] : []),
    finishing: [], attachments: [], synced_roots: [ROOT], discovered_roots: [ROOT], discovery_master: "",
    discovery_complete: true, cad_synced: false, warnings: [], ...payloadOverrides,
  };
  return {
    proposal: { id: "proposal", status: "pending", stagedAt: "", startedAt: null, runUrl: null, details: {}, summary: {},
      decidedBy: null, decidedAt: null, note: "", result: null, exclusions: [], review: null },
    payload, stale: false,
    assemblies: [{ id: 1, assembly_number: ROOT, subsystem_name: "Intake", latest_released_revision: "A", integration_status: null, discovery_master: null, active: true }],
    parts: requirements.map((row) => ({ id: row.part_id!, part_number: row.part_number!, name: row.part_number, description: null, material: null,
      manufacturing_method: null, vendor: null, revision: "A", onshape_url: null, category: null, drawing_url: null, active: true, cots: false })),
    requirements, operations: [], finishing: [], overrides: [], attachments: [], ...rest,
  };
}

test("a legacy requirement can't be kept, and unknown exclusions are refused", () => {
  const legacy = current(1, "P-OLD", { production_key: `${ROOT}|A|${ROOT}|P-OLD|default` });
  const review = buildSyncReview(state([legacy], []));
  const removal = review.changes.find((change) => change.kind === "removed")!;
  assert.equal(removal.excludable, false);
  assert.match(removal.blockedReason!, /revision-stable/);
  assert.throws(() => buildApprovedPayload(state([legacy], []), [removal.id]), SyncReviewError);
  assert.throws(() => buildApprovedPayload(state([legacy], []), ["remove:unknown"]), /changed while you were reviewing/);
});

test("skipping every root is refused unless the sync also updates Main membership", () => {
  const input = state([current(1, "P-1")], [incoming("P-1", { required_quantity: 3 })]);
  assert.throws(() => buildApprovedPayload(input, [`root:${ROOT}`]), /Deny the sync instead/);
  const membership = state([], [incoming("P-1")], { payload: { discovery_master: "https://cad.example.test/main" } });
  const { payload } = buildApprovedPayload(membership, [`root:${ROOT}`]);
  assert.deepEqual([payload.synced_roots, payload.requirements, payload.parts], [[], [], []]);
});

test("a skipped routing change is rebuilt from Onshape's last values, not the shop correction", () => {
  const row = current(1, "P-1");
  const input = state([{ ...row, machine_op1: "Bandsaw" }], [incoming("P-1", { machine_op1: "Haas CNC", required_quantity: 5 })], {
    overrides: [{ entity: "requirements", row_id: 1, field: "machine_op1", value: "Bandsaw", synced_value: "Lathe" }],
  });
  const change = buildSyncReview(input).changes[0];
  assert.deepEqual(change.fields.map((field) => [field.label, field.before, field.after]), [["Quantity", "2", "5"], ["Routing", "OP1 Lathe", "OP1 Haas CNC"]]);
  assert.match(change.fields[1].notes[0], /correction \(Bandsaw\) stays/);
  const { payload } = buildApprovedPayload(input, [`change:${key("P-1")}#routing`]);
  assert.equal(payload.requirements[0].machine_op1, "Lathe");
  assert.equal(payload.requirements[0].required_quantity, 5);
  assert.deepEqual(payload.operations.map((operation) => operation.machine), ["Lathe"]);
});

test("warnings make the commit partial, so removals are not predicted obsolete", () => {
  const review = buildSyncReview(state([current(1, "P-GONE")], [], { payload: { warnings: ["Root A-OTHER could not be resolved"] } }));
  assert.equal(review.partial, true);
  assert.match(review.notices[0], /commits as partial/);
  assert.match(review.changes[0].notes[0], /not marked obsolete/);
});

test("an inactive requirement that returns can be kept out, and a changed state changes the token", () => {
  const inactive = current(1, "P-BACK", { active_in_bom: false, obsolete: true });
  const input = state([inactive], [incoming("P-BACK")]);
  const review = buildSyncReview(input);
  assert.equal(review.changes[0].kind, "restored");
  assert.match(review.changes[0].notes.join(" "), /obsolete/);
  const { payload } = buildApprovedPayload(input, [review.changes[0].id]);
  assert.deepEqual([payload.requirements, payload.parts, payload.operations], [[], [], []]);
  const changed = buildSyncReview(state([{ ...inactive, required_quantity: 9 }], [incoming("P-BACK")]));
  assert.notEqual(changed.token, review.token);
});

test("a kept part that left every root is re-sent with its Onshape values", () => {
  const input = state([current(1, "P-KEEP"), current(2, "P-STAY")], [incoming("P-STAY")], {
    overrides: [{ entity: "parts", row_id: 1, field: "name", value: "Shop name", synced_value: "Onshape name" }],
  });
  const removal = buildSyncReview(input).changes.find((change) => change.kind === "removed")!;
  const { payload } = buildApprovedPayload(input, [removal.id]);
  const kept = payload.requirements.find((row) => row.part_number === "P-KEEP")!;
  assert.deepEqual([kept.source_assembly_revision, kept.active_in_bom, kept.required_quantity], ["B", true, 2]);
  assert.equal(payload.parts.find((row) => row.part_number === "P-KEEP")!.name, "Onshape name");
  assert.deepEqual(payload.operations.map((operation) => operation.production_key).sort(), [key("P-KEEP"), key("P-STAY")]);
});
