// Runs in isolated PostgreSQL/WASM; never contacts Supabase or Onshape. Loads the
// real engineering-sync RPC, its patches, and every trigger that runs after a
// sync, then drives staging, review, approval with exclusions, and denial.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildApprovedPayload, buildSyncReview, deniedReview, type SyncPayload, type SyncReviewState } from "../../lib/engineering-sync-review.ts";

const db = new PGlite();
const sql = async <T extends object = Record<string, unknown>>(query: string, params: unknown[] = []) => (await db.query<T>(query, params)).rows;
const install = async (path: string) => db.exec(await readFile(new URL(`../../${path}`, import.meta.url), "utf8"));
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create table public.profiles(id uuid primary key, display_name text, approved boolean, role text);
  create type public.quality_result as enum ('passed','failed');
  create table public.quality_control(id bigint generated always as identity primary key,
    production_requirement_id bigint, operation_id bigint, result public.quality_result,
    notes text, rejected_quantity integer, reviewed_by uuid, reviewed_at timestamptz, updated_at timestamptz);
  create schema frc190_baserow_stage; create table frc190_baserow_stage.snapshots(id uuid primary key);
  create schema storage;
  create table storage.buckets(id text primary key, public boolean not null default false);
  create table storage.objects(bucket_id text references storage.buckets(id), name text, primary key(bucket_id, name));
  insert into storage.buckets values('manufacturing-files', false);
`);
for (const path of [
  "supabase/production/20260905_normalized_manufacturing.sql",
  "supabase/production/20260905_manufacturing_writes.sql",
  "supabase/production/20260905_manufacturing_attachments.sql",
  "supabase/production/20260907_manufacturing_part_previews.sql",
  "supabase/production/20260909_requirement_notes.sql",
  "supabase/production/20260906_onshape_engineering_sync.sql",
  "supabase/migrations/20260906143937_preserve_cam_operations.sql",
  "supabase/production/20260910_preserve_unchanged_part_revisions.sql",
  "supabase/migrations/20260926000000_cots_parts.sql",
]) await install(path);
await db.exec("create function manufacturing.broadcast_change() returns trigger language plpgsql as $$ begin return null; end $$;");
for (const path of [
  "supabase/migrations/202609010003_notifications.sql",
  "supabase/migrations/20260910031802_assembly_glb_previews.sql",
  "supabase/migrations/20260911033920_initialize_synced_routing.sql",
  "supabase/migrations/20260918162451_requirement_obsoletion.sql",
  "supabase/migrations/20260919030147_obsolete_work_notifications.sql",
  "supabase/migrations/20260919222149_obsolete_removed_requirements.sql",
  "supabase/migrations/20260919223625_hide_obsolete_requirements.sql",
  "supabase/migrations/20260922190000_admin_engineering_overrides.sql",
  "supabase/migrations/20260923040000_passed_qc_quantity_corrections.sql",
  "supabase/migrations/20260923170000_requirement_history.sql",
  "supabase/migrations/20260924000000_configurable_qc_point.sql",
  "supabase/migrations/20260926010000_restored_requirement_robot_location.sql",
  "supabase/migrations/20260929120000_engineering_sync_review.sql",
]) await install(path);

const ADMIN = "00000000-0000-4000-8000-000000000190";
const MACHINIST = "00000000-0000-4000-8000-000000000191";
await sql("insert into auth.users values($1),($2)", [ADMIN, MACHINIST]);
await sql("insert into public.profiles values($1,'Alex A.',true,'admin'),($2,'Sam M.',true,'machinist')", [ADMIN, MACHINIST]);

const ROOT = "A-ROOT";
type Entry = { part: string; rev?: string; quantity?: number; machines?: string[]; finishing?: string };
type PartRow = { part_number: string; name?: string; material?: string; revision?: string };
function payload(rootRevision: string, entries: Entry[], partRows: PartRow[] = [], warnings: string[] = []): SyncPayload {
  const requirements: Record<string, unknown>[] = [], operations: Record<string, unknown>[] = [], finishing: Record<string, unknown>[] = [];
  const parts = new Map(partRows.map((part) => [part.part_number, part]));
  for (const { part, rev = "A", quantity = 2, machines = ["Milling Machine"], finishing: color = "None" } of entries) {
    const key = `${ROOT}|${rev}|${ROOT}|${part}|default|v2`;
    requirements.push({ production_key: key, part_number: part, assembly_number: ROOT, source_root: ROOT,
      source_assembly_revision: rootRevision, required_part_revision: rev, configuration: "default", required_quantity: quantity,
      bom_positions: "1", onshape_url: `https://cad.example.test/${part}/${rev}`, source_document: "Intake Doc", finishing: color,
      machine_op1: machines[0] ?? null, machine_op2: machines[1] ?? null, machine_op3: machines[2] ?? null, machine_op4: machines[3] ?? null,
      active_in_bom: true });
    machines.forEach((machine, index) => operations.push({ operation_key: `${key}|OP${index + 1}`, production_key: key,
      operation_number: `OP${index + 1}`, machine, active_in_routing: true, work_type: "Manufacturing" }));
    if (color !== "None") finishing.push({ production_key: key, color, required_quantity: quantity, active: true });
    if (!parts.has(part)) parts.set(part, { part_number: part, name: part.replace("P-", ""), material: "6061", revision: rev });
  }
  return {
    assemblies: [{ assembly_number: ROOT, subsystem_name: "Intake", active: true, sync_schema_version: "supabase-engineering-v2",
      latest_released_revision: rootRevision, integration_status: "Not Compared", discovery_master: "", onshape_url: "https://cad.example.test/root" }],
    parts: [...parts.values()].map((part) => ({ ...part, active: true })),
    requirements, operations, finishing, attachments: [], synced_roots: [ROOT], discovered_roots: [ROOT], discovery_master: "",
    discovery_complete: true, cad_synced: false, warnings, source_rows: entries.length, file_groups_cached: 0,
  };
}
const begin = async () => {
  const id = randomUUID();
  await sql("select public.manufacturing_begin_engineering_sync($1,'https://example.test/run')", [id]);
  return id;
};
const applyDirect = async (body: SyncPayload) =>
  (await sql<{ result: Record<string, unknown> }>("select public.manufacturing_apply_engineering_sync($1,$2::jsonb) result", [await begin(), JSON.stringify(body)]))[0].result;
const stage = async (body: SyncPayload) => {
  const id = await begin();
  const result = (await sql<{ result: Record<string, unknown> }>("select public.manufacturing_stage_engineering_sync($1,$2::jsonb,$3::jsonb) result",
    [id, JSON.stringify(body), JSON.stringify({ label: "Poot Horse" })]))[0].result;
  return { id, result };
};
const reviewState = async (id: string) =>
  (await sql<{ result: SyncReviewState }>("select public.manufacturing_engineering_sync_review_state($1) result", [id]))[0].result;
const decide = async (id: string, decision: "approve" | "deny", body: SyncPayload | null, exclusions: string[] = [], actor = ADMIN) =>
  (await sql<{ result: Record<string, unknown> }>("select public.manufacturing_decide_engineering_sync($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7) result",
    [id, actor, decision, body ? JSON.stringify(body) : null, JSON.stringify(exclusions), JSON.stringify({ test: true }), "Checked with CAD"]))[0].result;
const requirement = async (part: string, rev = "A") => (await sql<Record<string, unknown>>(`select r.* from manufacturing.requirements r
  join manufacturing.parts p on p.id=r.part_id where p.part_number=$1 and r.required_part_revision=$2`, [part, rev]))[0];
const run = async (id: string) => (await sql<{ status: string }>("select status from manufacturing.engineering_sync_runs where id=$1", [id]))[0].status;
const proposalStatus = async (id: string) => (await sql<{ status: string }>("select status from manufacturing.engineering_sync_proposals where run_id=$1", [id]))[0].status;

const INITIAL: Entry[] = [
  { part: "P-KEEP" }, { part: "P-GONE", machines: ["Lathe"] }, { part: "P-QTY", quantity: 4, finishing: "Red" },
  { part: "P-REV", quantity: 3 }, { part: "P-REV2" }, { part: "P-NAME" },
];
assert.equal((await applyDirect(payload("A", INITIAL, [{ part_number: "P-NAME", name: "Bracket", material: "6061" }]))).status, "success");
// A shop correction to P-NAME's material, as the admin override editor stores it.
await sql(`insert into manufacturing.engineering_overrides(entity,row_id,field,value,synced_value,created_by,created_by_name,updated_by,updated_by_name)
  select 'parts',id,'material','"7075"','"6061"',$1,'Alex A.',$1,'Alex A.' from manufacturing.parts where part_number='P-NAME'`, [ADMIN]);
await sql("update manufacturing.parts set material='7075' where part_number='P-NAME'");
// Recorded shop work on the requirement Onshape will drop.
await sql(`update manufacturing.operations set claimed_quantity=1, status='In Progress'
  where requirement_id=(select r.id from manufacturing.requirements r join manufacturing.parts p on p.id=r.part_id where p.part_number='P-KEEP')`);

const NEXT = payload("B", [
  { part: "P-QTY", quantity: 6, machines: ["Haas CNC"], finishing: "Red" },
  { part: "P-REV", rev: "B", quantity: 3 }, { part: "P-REV2", rev: "B" }, { part: "P-NAME" },
  { part: "P-NEW", quantity: 5 }, { part: "P-SKIP" },
], [{ part_number: "P-NAME", name: "Bracket v2", material: "6061-T6" }]);

test("staging stores the payload, alerts admins, and changes nothing else", async () => {
  const before = await sql("select * from manufacturing.requirements order by id");
  const { id, result } = await stage(NEXT);
  assert.equal(result.status, "staged");
  assert.equal(await run(id), "staged");
  assert.deepEqual(await sql("select * from manufacturing.requirements order by id"), before);
  const alerts = await sql<{ recipient_id: string; data: { href: string } }>("select recipient_id, data from public.notifications where type='engineering_sync_review'");
  assert.deepEqual(alerts.map((alert) => alert.recipient_id), [ADMIN]);
  assert.equal(alerts[0].data.href, `/admin/sync?proposal=${id}`);
  // A retry after an uncertain response is harmless.
  const retry = (await sql<{ result: { status: string } }>("select public.manufacturing_stage_engineering_sync($1,'{}'::jsonb,'{}'::jsonb) result", [id]))[0].result;
  assert.equal(retry.status, "staged");
  // Shop writes while a proposal waits are not sync obsoletion candidates.
  await sql("update manufacturing.requirements set production_notes='Waiting on CAD' where id=(select min(id) from manufacturing.requirements)");
  assert.equal((await sql<{ count: number }>("select count(*)::int count from manufacturing.obsoletion_sync_candidates"))[0].count, 0);
  // Denying commits nothing.
  const engineering = "select production_key, required_quantity, active_in_bom, obsolete, source_assembly_revision from manufacturing.requirements order by id";
  const beforeDenial = await sql(engineering);
  assert.equal((await decide(id, "deny", null)).proposal_status, "denied");
  assert.equal(await run(id), "denied");
  assert.deepEqual(await sql(engineering), beforeDenial);
  assert.equal((await sql<{ count: number }>("select count(*)::int count from public.notifications where type='engineering_sync_review' and read_at is null"))[0].count, 0);
  await assert.rejects(decide(id, "approve", NEXT), /already denied/);
});

test("the review lists additions, removals, revisions, and field changes", async () => {
  const { id } = await stage(NEXT);
  const review = buildSyncReview(await reviewState(id));
  const byTitle = (part: string) => review.changes.filter((change) => change.partNumber === part).map((change) => change.kind).sort();
  assert.deepEqual(byTitle("P-KEEP"), ["removed"]);
  assert.deepEqual(byTitle("P-GONE"), ["removed"]);
  assert.deepEqual(byTitle("P-REV"), ["revised"]);
  assert.deepEqual(byTitle("P-NEW"), ["added"]);
  assert.deepEqual(byTitle("P-NAME"), ["part"]);
  const quantity = review.changes.find((change) => change.partNumber === "P-QTY")!;
  assert.deepEqual(quantity.fields.map((field) => [field.label, field.before, field.after]),
    [["Quantity", "4", "6"], ["Routing", "OP1 Milling Machine", "OP1 Haas CNC"]]);
  const part = review.changes.find((change) => change.kind === "part")!;
  // The diff compares against Onshape's last value, not the shop's correction.
  assert.deepEqual(part.fields.map((field) => [field.label, field.before, field.after]),
    [["Name", "Bracket", "Bracket v2"], ["Material", "6061", "6061-T6"]]);
  assert.match(part.fields[1].notes[0], /correction \(7075\) stays/);
  const kept = review.changes.find((change) => change.partNumber === "P-KEEP")!;
  assert.match(kept.warnings.join(" "), /Claimed work: OP1 Milling Machine/);
  assert.match(kept.notes[0], /Marked obsolete: removed from the BOM/);
  assert.match(review.changes.find((change) => change.partNumber === "P-REV2")!.notes[0], /replaced by rev B/);
  assert.deepEqual(review.roots, [{ root: ROOT, name: "Intake", before: "A", after: "B", changes: review.changes.length }]);
  assert.equal(review.partial, false);
});

test("approval commits only the included changes through the engineering RPC", async () => {
  const [{ run_id: id }] = await sql<{ run_id: string }>("select run_id from manufacturing.engineering_sync_proposals where status='pending'");
  const state = await reviewState(id);
  const skip = [
    `remove:${ROOT}|A|${ROOT}|P-KEEP|default|v2`,
    `revise:${ROOT}|B|${ROOT}|P-REV|default|v2`,
    `add:${ROOT}|A|${ROOT}|P-SKIP|default|v2`,
    `change:${ROOT}|A|${ROOT}|P-QTY|default|v2#quantity`,
    "part:P-NAME#material",
  ];
  const { payload: approved, review } = buildApprovedPayload(state, skip);
  const result = await decide(id, "approve", approved, skip);
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.proposal_status, "approved");
  assert.equal(await run(id), "success");
  assert.equal(review.changes.filter((change) => !change.applied).length, 3);

  const keep = await requirement("P-KEEP");
  assert.deepEqual([keep.active_in_bom, keep.obsolete, keep.source_assembly_revision], [true, false, "B"]);
  assert.equal(Number((await sql<{ claimed_quantity: number }>("select claimed_quantity from manufacturing.operations where requirement_id=$1", [keep.id]))[0].claimed_quantity), 1);
  const gone = await requirement("P-GONE");
  assert.deepEqual([gone.active_in_bom, gone.obsolete, gone.obsoletion_origin], [false, true, "automatic"]);
  const qty = await requirement("P-QTY");
  assert.equal(Number(qty.required_quantity), 4);
  assert.deepEqual((await sql("select machine from manufacturing.operations where requirement_id=$1 and work_type='Manufacturing' and active_in_routing", [qty.id])),
    [{ machine: "Haas CNC" }]);
  assert.equal(Number((await sql<{ required_quantity: number }>("select required_quantity from manufacturing.finishing where requirement_id=$1", [qty.id]))[0].required_quantity), 4);
  assert.equal((await requirement("P-REV")).active_in_bom, true);
  assert.equal(await requirement("P-REV", "B"), undefined);
  const oldRevision = await requirement("P-REV2"), newRevision = await requirement("P-REV2", "B");
  assert.deepEqual([oldRevision.active_in_bom, oldRevision.obsolete, oldRevision.obsolete_replacement_id], [false, true, newRevision.id]);
  const added = await requirement("P-NEW");
  assert.equal(Number(added.required_quantity), 5);
  // Routing initialization ran after the approved commit.
  assert.equal((await sql<{ status: string }>("select status from manufacturing.operations where requirement_id=$1", [added.id]))[0].status, "Ready");
  assert.deepEqual(await sql("select * from manufacturing.parts where part_number='P-SKIP'"), []);
  const [name] = await sql<{ name: string; material: string }>("select name, material from manufacturing.parts where part_number='P-NAME'");
  assert.deepEqual(name, { name: "Bracket v2", material: "7075" });
  const [override] = await sql<{ synced_value: unknown }>("select synced_value from manufacturing.engineering_overrides where field='material'");
  assert.equal(override.synced_value, "6061");
  await assert.rejects(decide(id, "deny", null), /already approved/);
});

test("a newer sync supersedes a waiting proposal and a stale proposal fails safely", async () => {
  const first = await stage(payload("C", INITIAL.slice(0, 2)));
  const second = await stage(payload("C", INITIAL.slice(0, 3)));
  assert.equal(await proposalStatus(first.id), "superseded");
  assert.equal(await run(first.id), "superseded");
  assert.deepEqual(second.result.superseded, [first.id]);
  await assert.rejects(decide(first.id, "approve", payload("C", INITIAL)), /already superseded/);

  // Another sync commits while the second proposal waits.
  const committed = await applyDirect(payload("C", INITIAL));
  assert.equal(committed.status, "success");
  const state = await reviewState(second.id);
  assert.equal(state.stale, true);
  const failed = await decide(second.id, "approve", buildApprovedPayload(state, []).payload);
  assert.equal(failed.status, "failed");
  assert.match(String(failed.error), /Another engineering run committed/);
  assert.equal(await proposalStatus(second.id), "failed");
  assert.equal((await decide(second.id, "deny", null, [], ADMIN)).proposal_status, "denied");
  assert.equal(deniedReview(state)?.changes.every((change) => !change.applied), true);
});

test("only approved administrators decide, and only the service role can call the RPCs", async () => {
  const { id } = await stage(payload("D", INITIAL));
  await assert.rejects(decide(id, "deny", null, [], MACHINIST), /Approved administrator required/);
  for (const signature of [
    "public.manufacturing_stage_engineering_sync(uuid,jsonb,jsonb)",
    "public.manufacturing_engineering_sync_proposals(integer)",
    "public.manufacturing_engineering_sync_review_state(uuid)",
    "public.manufacturing_decide_engineering_sync(uuid,uuid,text,jsonb,jsonb,jsonb,text)",
  ]) {
    for (const [role, allowed] of [["authenticated", false], ["anon", false], ["service_role", true]] as const) {
      const [{ ok }] = await sql<{ ok: boolean }>("select has_function_privilege($1,$2,'execute') ok", [role, signature]);
      assert.equal(ok, allowed, `${role} ${signature}`);
    }
  }
  const list = (await sql<{ result: Array<{ id: string; status: string }> }>("select public.manufacturing_engineering_sync_proposals(10) result"))[0].result;
  assert.equal(list[0].id, id);
  assert.equal(list[0].status, "pending");
});
