// Runs in isolated PostgreSQL/WASM; never contacts Supabase or Onshape. The real
// write adapter talks to PGlite through a minimal PostgREST-shaped fetch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createSupabaseWriteAdapter } from "../../lib/manufacturing/write-adapter.ts";
import type { EngineeringOverrideState } from "../../lib/engineering-overrides.ts";

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
await install("supabase/production/20260905_normalized_manufacturing.sql");
await install("supabase/production/20260905_manufacturing_writes.sql");
await install("supabase/production/20260905_manufacturing_attachments.sql");
await install("supabase/production/20260907_manufacturing_part_previews.sql");
await db.exec(`
  alter table manufacturing.attachments alter column source_field_id drop not null;
  create function manufacturing.broadcast_change() returns trigger language plpgsql as $$ begin return null; end $$;
  create table manufacturing.engineering_sync_runs(id integer primary key, status text,
    started_at timestamptz not null default clock_timestamp());
`);
await install("supabase/migrations/20260910031802_assembly_glb_previews.sql");
await install("supabase/migrations/20260911033920_initialize_synced_routing.sql");
await install("supabase/migrations/20260918162451_requirement_obsoletion.sql");
await install("supabase/migrations/20260919223625_hide_obsolete_requirements.sql");
await install("supabase/migrations/20260922190000_admin_engineering_overrides.sql");
await install("supabase/migrations/20260923040000_passed_qc_quantity_corrections.sql");
await install("supabase/migrations/20260923170000_requirement_history.sql");
await install("supabase/migrations/20260924000000_configurable_qc_point.sql");

const ADMIN = { id: "00000000-0000-4000-8000-000000000190", name: "Alex A." };
const MACHINIST = "00000000-0000-4000-8000-000000000191";
await sql("insert into auth.users values($1),($2)", [ADMIN.id, MACHINIST]);
await sql("insert into public.profiles values($1,'Alex A.',true,'admin'),($2,'Sam M.',true,'machinist')", [ADMIN.id, MACHINIST]);
await db.exec(`update manufacturing.write_control set enabled=true;
  insert into manufacturing.assemblies(id,assembly_number) values(1,'A-1');
  insert into manufacturing.parts(id,part_number,name,material,last_synced_at) values(1,'P-1','Bracket','6061',now()),(2,'P-2','Plate','Steel',now());
  select setval(pg_get_serial_sequence('manufacturing.parts','id'), 2);
  select setval(pg_get_serial_sequence('manufacturing.assemblies','id'), 1);`);

// Every RPC used by the adapter, in PostgreSQL argument order.
const SIGNATURES: Record<string, string[]> = {
  manufacturing_write_state: [],
  manufacturing_engineering_correction_list: [],
  manufacturing_engineering_override_state: ["p_requirement_id:bigint"],
  manufacturing_requirement_history: ["p_requirement_id:bigint"],
  manufacturing_apply_engineering_overrides: ["p_request_id:uuid", "p_actor:uuid", "p_expected:text", "p_override_token:text",
    "p_requirement_id:bigint", "p_overrides:jsonb", "p_changes:jsonb", "p_inserts:jsonb", "p_reason:text", "p_result:jsonb"],
  manufacturing_set_attachment_override: ["p_request_id:uuid", "p_actor:uuid", "p_override_token:text", "p_requirement_id:bigint",
    "p_kind:text", "p_file:jsonb", "p_reason:text"],
};
const adapter = createSupabaseWriteAdapter({ url: "https://example.test", serviceKey: "test", fetch: async (input, init) => {
  const url = new URL(String(input));
  const name = url.pathname.split("/").pop()!;
  if (name === "manufacturing_read_entity") {
    const rows = await sql(`select public.manufacturing_read_entity($1,$2,$3) page`,
      [url.searchParams.get("p_entity"), Number(url.searchParams.get("p_offset")), Number(url.searchParams.get("p_limit"))]);
    return Response.json(rows[0].page);
  }
  const signature = SIGNATURES[name];
  if (!signature) throw new Error(`Unexpected RPC ${name}`);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const args = signature.map((entry, index) => `${entry.split(":")[0]} => $${index + 1}::${entry.split(":")[1]}`);
  const values = signature.map((entry) => {
    const value = body[entry.split(":")[0]];
    return entry.endsWith("jsonb") ? (value === undefined ? null : JSON.stringify(value)) : value ?? null;
  });
  try {
    const rows = await sql<{ result: unknown }>(`select public.${name}(${args.join(", ")}) result`, values);
    return Response.json(rows[0].result);
  } catch (error) {
    const { code, message } = error as { code?: string; message: string };
    return Response.json({ code, message }, { status: code === "PT409" ? 409 : 400 });
  }
} });

let requirementSeed = 0;
async function requirement(options: { quantity?: number; finishing?: string; machines?: string[]; qc?: string; status?: string; part?: number } = {}) {
  const key = `ROOT|A|A-1|P-${++requirementSeed}|default|v2`;
  const machines = options.machines ?? ["Milling Machine"];
  const id = (await sql<{ id: number }>(`insert into manufacturing.requirements(production_key,part_id,assembly_id,source_root,
      required_part_revision,source_assembly_revision,active_in_bom,required_quantity,finishing,status,qc_outcome,
      machine_op1,machine_op2,machine_op3,machine_op4,last_synced_at)
    values($1,$2,1,'ROOT','A','A',true,$3,$4,$5,$6,$7,$8,$9,$10,now()) returning id`,
  [key, options.part ?? 1, options.quantity ?? 4, options.finishing ?? "None", options.status ?? "Ready for Manufacturing",
    options.qc ?? "Not Inspected", machines[0] ?? null, machines[1] ?? null, machines[2] ?? null, machines[3] ?? null]))[0].id;
  for (const [index, machine] of machines.entries()) {
    await sql(`insert into manufacturing.operations(operation_key,requirement_id,operation_number,machine,work_type,active_in_routing,
      status,claimed_quantity,completed_quantity,quantity_ledger) values($1,$2,$3,$4,'Manufacturing',true,$5,0,0,'[]')`,
    [`${key}|OP${index + 1}`, id, `OP${index + 1}`, machine, index === 0 ? "Ready" : "Planned"]);
  }
  if (options.finishing && options.finishing !== "None") {
    await sql(`insert into manufacturing.finishing(production_key,requirement_id,color,required_quantity,active)
      values($1,$2,$3,$4,true)`, [key, id, options.finishing, options.quantity ?? 4]);
  }
  return { id, key };
}
const state = (id: number) => adapter.readEngineeringOverrideState(id) as Promise<EngineeringOverrideState>;
const row = async (table: string, id: number) => (await sql(`select * from manufacturing.${table} where id=$1`, [id]))[0];
const ops = (id: number) => sql<Record<string, unknown>>(
  "select * from manufacturing.operations where requirement_id=$1 order by operation_number, work_type desc, id", [id]);

/** Simulates manufacturing_apply_engineering_sync writing Onshape values, then finishing the run. */
let runId = 0;
async function sync(write: string, status = "success") {
  await db.transaction(async (tx) => {
    const run = ++runId;
    await tx.query("insert into manufacturing.engineering_sync_runs(id,status,started_at) values($1,'running',clock_timestamp())", [run]);
    await tx.exec(write);
    await tx.query("update manufacturing.engineering_sync_runs set status=$2 where id=$1", [run, status]);
  });
}

test("quantity, material, and finishing survive syncs and retire once Onshape agrees", async () => {
  const { id } = await requirement({ quantity: 4 });
  let current = await state(id);
  const result = await adapter.applyEngineeringOverrides(id, {
    quantity: { value: 2 }, material: { value: "7075-T6" }, finishing: { value: "Black" },
  }, current.token, "BOM double counted", ADMIN);
  assert.deepEqual(result.changes.map((change) => change.field).sort(), ["Finishing", "Material", "Quantity"]);
  assert.equal(Number((await row("requirements", id)).required_quantity), 2);
  assert.equal((await row("parts", 1)).material, "7075-T6");
  const [finishing] = await sql("select * from manufacturing.finishing where requirement_id=$1", [id]);
  assert.deepEqual([finishing.color, Number(finishing.required_quantity), finishing.active], ["Black", 2, true]);
  current = await state(id);
  assert.deepEqual(current.overrides.map((override) => [override.field, override.value, override.synced_value]).sort(),
    [["finishing", "Black", "None"], ["material", "7075-T6", "6061"], ["required_quantity", 2, 4]]);

  // Onshape still sends its values; they are captured, and the corrections win.
  await sync(`update manufacturing.requirements set required_quantity=5, finishing='None', last_synced_at=clock_timestamp() where id=${id};
    update manufacturing.finishing set active=false where requirement_id=${id};
    update manufacturing.parts set material='6061', last_synced_at=clock_timestamp() where id=1;`);
  assert.equal(Number((await row("requirements", id)).required_quantity), 2);
  assert.equal((await row("requirements", id)).finishing, "Black");
  assert.equal((await row("parts", 1)).material, "7075-T6");
  assert.equal((await sql("select active from manufacturing.finishing where requirement_id=$1", [id]))[0].active, true);
  current = await state(id);
  assert.equal(current.overrides.find((override) => override.field === "required_quantity")?.synced_value, 5);

  // Failed runs never trigger re-application or retirement (the real sync also rolls back its writes).
  await sync(`update manufacturing.requirements set required_quantity=7, last_synced_at=clock_timestamp() where id=${id}`, "failed");
  assert.equal(Number((await row("requirements", id)).required_quantity), 7);
  assert.equal((await state(id)).overrides.length, 3);

  await sync(`update manufacturing.requirements set required_quantity=2, finishing='None', last_synced_at=clock_timestamp() where id=${id};
    update manufacturing.finishing set active=false where requirement_id=${id};
    update manufacturing.parts set material='6061', last_synced_at=clock_timestamp() where id=1;`);
  current = await state(id);
  assert.deepEqual(current.overrides.map((override) => override.field).sort(), ["finishing", "material"]);
  assert.deepEqual((await sql("select action from manufacturing.engineering_override_events where field='required_quantity' order by id"))
    .map((event) => event.action), ["set", "retired"]);

  // Reverting restores the retained Onshape value.
  await adapter.applyEngineeringOverrides(id, { material: { revert: true }, finishing: { revert: true } }, current.token, "", ADMIN);
  assert.equal((await row("parts", 1)).material, "6061");
  assert.equal((await row("requirements", id)).finishing, "None");
  assert.equal((await sql("select active from manufacturing.finishing where requirement_id=$1", [id]))[0].active, false);
  assert.equal((await state(id)).overrides.length, 0);
});

test("routing corrections create CAM prerequisites, re-plan readiness, and survive routing syncs", async () => {
  const { id, key } = await requirement({ machines: ["Milling Machine", "Tapping"] });
  const before = await state(id);
  await adapter.applyEngineeringOverrides(id, { routing: { value: ["Haas CNC", "Tapping", "Threaded Insert", null] } }, before.token, "", ADMIN);
  let rows = await ops(id);
  const cam = rows.find((operation) => operation.work_type === "CAM")!;
  assert.deepEqual([cam.operation_key, cam.machine, cam.status, cam.active_in_routing], [`${key}|CAM|OP1`, "Haas CNC", "Ready", true]);
  const op1 = rows.find((operation) => operation.operation_key === `${key}|OP1`)!;
  assert.deepEqual([op1.machine, op1.status], ["Haas CNC", "Planned"]);
  assert.equal(rows.find((operation) => operation.operation_key === `${key}|OP3`)?.machine, "Threaded Insert");
  assert.equal((await row("requirements", id)).status, "Ready for CAM");

  // The sync reverts the machine and deactivates the admin-added stage; the correction is re-applied.
  await sync(`update manufacturing.requirements set machine_op1='Milling Machine', machine_op3=null, last_synced_at=clock_timestamp() where id=${id};
    update manufacturing.operations set machine='Milling Machine' where operation_key='${key}|OP1';
    update manufacturing.operations set active_in_routing=false where operation_key='${key}|OP3';`);
  rows = await ops(id);
  assert.equal(rows.find((operation) => operation.operation_key === `${key}|OP1`)?.machine, "Haas CNC");
  assert.equal(rows.find((operation) => operation.operation_key === `${key}|OP3`)?.active_in_routing, true);
  assert.equal((await row("requirements", id)).machine_op3, "Threaded Insert");

  // Work on a stage blocks changing it.
  await sql(`update manufacturing.operations set claimed_quantity=1, status='In Progress', quantity_ledger=$2 where operation_key=$1`,
    [`${key}|OP2`, JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 1, completed: 0 }])]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { routing: { value: ["Haas CNC", "Lathe", "Threaded Insert", null] } },
    (await state(id)).token, "", ADMIN), /OP2 \(Tapping\) has recorded work/);

  // Reverting OP1/OP3 goes back to Onshape's routing and retires the CAM task.
  await adapter.applyEngineeringOverrides(id, { routing: { revert: true } }, (await state(id)).token, "", ADMIN);
  rows = await ops(id);
  assert.equal(rows.find((operation) => operation.operation_key === `${key}|OP1`)?.machine, "Milling Machine");
  assert.equal(rows.find((operation) => operation.work_type === "CAM")?.active_in_routing, false);
  assert.equal(rows.find((operation) => operation.operation_key === `${key}|OP3`)?.active_in_routing, false);
  assert.equal((await state(id)).overrides.length, 0);
});

test("routing edits and reverts cannot remove the last manufacturing operation", async () => {
  const { id } = await requirement();
  const before = await ops(id);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { routing: { value: [null, null, null, null] } },
    (await state(id)).token, "", ADMIN), /Keep at least one operation/);
  assert.deepEqual(await ops(id), before);

  // Onshape can remove the original route while an administrator correction survives.
  await adapter.applyEngineeringOverrides(id, { routing: { value: ["Lathe", null, null, null] } },
    (await state(id)).token, "", ADMIN);
  await sync(`update manufacturing.requirements set machine_op1=null, last_synced_at=clock_timestamp() where id=${id};
    update manufacturing.operations set active_in_routing=false where requirement_id=${id};`);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { routing: { revert: true } },
    (await state(id)).token, "", ADMIN), /Keep at least one operation/);
  assert.equal((await ops(id))[0].active_in_routing, true);
  assert.equal((await row("requirements", id)).machine_op1, "Lathe");
});

test("quantity changes protect claims and passed QC, and completed stages follow the new quantity", async () => {
  const { id, key } = await requirement({ quantity: 4, machines: ["Milling Machine", "Tapping"] });
  await sql(`update manufacturing.operations set completed_quantity=2, status='Ready', quantity_ledger=$2 where operation_key=$1`,
    [`${key}|OP1`, JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 0, completed: 2 }])]);
  await adapter.applyEngineeringOverrides(id, { quantity: { value: 2 } }, (await state(id)).token, "", ADMIN);
  let rows = await ops(id);
  assert.deepEqual(rows.map((operation) => operation.status), ["Complete", "Ready"]);
  assert.ok(rows[0].completed_at);

  await sql(`update manufacturing.operations set claimed_quantity=1, status='In Progress', quantity_ledger=$2 where operation_key=$1`,
    [`${key}|OP2`, JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 1, completed: 0 }])]);
  await adapter.applyEngineeringOverrides(id, { quantity: { value: 3 } }, (await state(id)).token, "", ADMIN);
  rows = await ops(id);
  assert.deepEqual(rows.map((operation) => operation.status), ["Ready", "In Progress"]);
  assert.equal(rows[0].completed_at, null);

  await sql(`update manufacturing.operations set claimed_quantity=3, quantity_ledger=$2 where operation_key=$1`,
    [`${key}|OP2`, JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 3, completed: 0 }])]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { quantity: { value: 2 } }, (await state(id)).token, "", ADMIN),
    /OP2 already has 3 parts claimed/);

  const passed = await requirement({ quantity: 2, qc: "Passed", status: "Complete" });
  await assert.rejects(adapter.applyEngineeringOverrides(passed.id, { quantity: { value: 3 } }, (await state(passed.id)).token, "", ADMIN),
    /Choose whether QC approved the corrected quantity/);
});

/** A part whose every operation is complete for `quantity` parts, made by the machinist and passed by QC. */
async function passedPart(options: { quantity: number; machines?: string[]; finishing?: string; status?: string }) {
  const created = await requirement({ ...options, qc: "Passed", status: options.status ?? "Complete" });
  await sql(`update manufacturing.operations set status='Complete', completed_at=now(), completed_quantity=$2, quantity_ledger=$3,
    machinist='Sam M.' where requirement_id=$1`,
  [created.id, options.quantity, JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 0, completed: options.quantity }])]);
  return created;
}
const ledgers = async (id: number) => (await ops(id)).map((operation) => JSON.parse(String(operation.quantity_ledger))
  .map((allocation: { name: string; completed: number }) => `${allocation.name}:${allocation.completed}`).join(","));

test("after QC, 'approved' rewrites completed counts to the corrected quantity and keeps the pass", async () => {
  const { id } = await passedPart({ quantity: 2, machines: ["Milling Machine", "Tapping"] });
  const result = await adapter.applyEngineeringOverrides(id, { quantity: { value: 3 }, passedQcQuantity: "approved" },
    (await state(id)).token, "Shop made three", ADMIN);
  assert.ok(result.changes.some((change) => change.field === "QC approved quantity" && change.from === "2" && change.to === "3"));
  let rows = await ops(id);
  assert.deepEqual(rows.map((operation) => [operation.status, Number(operation.completed_quantity)]), [["Complete", 3], ["Complete", 3]]);
  assert.deepEqual(await ledgers(id), ["Sam M.:2,Alex A.:1", "Sam M.:2,Alex A.:1"]);
  assert.equal(rows[0].machinist, "Sam M. (2), Alex A. (1)");
  assert.deepEqual((await sql("select display_name, completed from manufacturing.operation_allocations where operation_id=$1 order by ordinal", [rows[0].id]))
    .map((allocation) => `${allocation.display_name}:${Number(allocation.completed)}`), ["Sam M.:2", "Alex A.:1"]);
  assert.deepEqual([(await row("requirements", id)).qc_outcome, (await row("requirements", id)).status], ["Passed", "Complete"]);

  // Decreasing removes the most recent credit first.
  await adapter.applyEngineeringOverrides(id, { quantity: { value: 1 }, passedQcQuantity: "approved" }, (await state(id)).token, "", ADMIN);
  rows = await ops(id);
  assert.deepEqual(rows.map((operation) => Number(operation.completed_quantity)), [1, 1]);
  assert.deepEqual(await ledgers(id), ["Sam M.:1", "Sam M.:1"]);
  assert.equal((await row("requirements", id)).qc_outcome, "Passed");
});

test("after QC, 'made' keeps completed counts: extras are discarded, and a shortfall reopens work and QC", async () => {
  const fewer = await passedPart({ quantity: 3 });
  await adapter.applyEngineeringOverrides(fewer.id, { quantity: { value: 2 }, passedQcQuantity: "made" }, (await state(fewer.id)).token, "", ADMIN);
  assert.deepEqual((await ops(fewer.id)).map((operation) => [operation.status, Number(operation.completed_quantity)]), [["Complete", 3]]);
  assert.deepEqual([(await row("requirements", fewer.id)).qc_outcome, Number((await row("requirements", fewer.id)).required_quantity)], ["Passed", 2]);

  const more = await passedPart({ quantity: 2, machines: ["Milling Machine", "Tapping", "Threaded Insert"], finishing: "Red" });
  await sql("update manufacturing.requirements set part_location='On Robot' where id=$1", [more.id]);
  await assert.rejects(adapter.applyEngineeringOverrides(more.id, { quantity: { value: 4 }, passedQcQuantity: "made" }, (await state(more.id)).token, "", ADMIN),
    /off the robot/);
  await sql("update manufacturing.requirements set part_location='Shelf 1' where id=$1", [more.id]);
  const result = await adapter.applyEngineeringOverrides(more.id, { quantity: { value: 4 }, passedQcQuantity: "made" }, (await state(more.id)).token, "", ADMIN);
  assert.ok(result.changes.some((change) => change.field === "QC" && /2 more/.test(change.to)));
  const rows = await ops(more.id);
  assert.deepEqual(rows.map((operation) => [operation.machine, operation.status, Number(operation.completed_quantity)]),
    [["Milling Machine", "Ready", 2], ["Tapping", "Planned", 2], ["Threaded Insert", "Planned", 2]]);
  assert.deepEqual(await ledgers(more.id), ["Sam M.:2", "Sam M.:2", "Sam M.:2"]);
  const updated = await row("requirements", more.id);
  assert.deepEqual([updated.qc_outcome, updated.status], ["Not Inspected", "Ready for Manufacturing"]);
  assert.equal(Number((await sql("select required_quantity from manufacturing.finishing where requirement_id=$1", [more.id]))[0].required_quantity), 4);
});

test("the RPC only rewrites completed counts for a passed-QC quantity correction", async () => {
  const { id } = await passedPart({ quantity: 2 });
  const [operation] = await ops(id);
  const write = (await sql<{ state: { token: string } }>("select public.manufacturing_write_state() state"))[0].state;
  const ledger = JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 0, completed: 5 }]);
  const token = (await state(id)).token;
  const call = (overrides: unknown[], changes: unknown[]) => sql(`select public.manufacturing_apply_engineering_overrides(
      $1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb,'[]'::jsonb,'',null) result`,
  [crypto.randomUUID(), ADMIN.id, write.token, token, id, JSON.stringify(overrides), JSON.stringify(changes)]);
  await assert.rejects(call([], [{ entity: "operations", id: operation.id, patch: { completed_quantity: 5, quantity_ledger: ledger } }]),
    /only follow a passed-QC quantity correction/);
  const quantity = [{ entity: "requirements", row_id: id, field: "required_quantity", action: "set", value: 4 }];
  await assert.rejects(call(quantity, [{ entity: "requirements", id, patch: { required_quantity: 4 } },
    { entity: "operations", id: operation.id, patch: { completed_quantity: 5, quantity_ledger: ledger } }]), /must match the corrected quantity/);
  await assert.rejects(call(quantity, [{ entity: "requirements", id, patch: { required_quantity: 4 } },
    { entity: "operations", id: operation.id, patch: { completed_quantity: 4, quantity_ledger: ledger } }]), /Allocation totals/);
});

test("adding finishing after QC routes the part to finishing; removing a claimed job is blocked", async () => {
  const { id } = await requirement({ quantity: 1, qc: "Passed", status: "Complete" });
  await sql("update manufacturing.operations set status='Complete', completed_quantity=1 where requirement_id=$1", [id]);
  await adapter.applyEngineeringOverrides(id, { finishing: { value: "Red" } }, (await state(id)).token, "", ADMIN);
  assert.equal((await row("requirements", id)).status, "Ready for Finishing");
  await sql("update manufacturing.finishing set machinist='Sam M.' where requirement_id=$1", [id]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { finishing: { revert: true } }, (await state(id)).token, "", ADMIN),
    /Release the finishing claim/);
});

test("stale tokens, non-admins, disabled writes, and obsolete requirements are rejected", async () => {
  const { id } = await requirement();
  const stale = (await state(id)).token;
  await sql("update manufacturing.parts set material='Delrin' where id=1");
  await assert.rejects(adapter.applyEngineeringOverrides(id, { material: { value: "PLA" } }, stale, "", ADMIN), /changed/);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { material: { value: "PLA" } }, (await state(id)).token, "",
    { id: MACHINIST, name: "Sam M." }), /not authorized/);
  await db.exec("update manufacturing.write_control set enabled=false");
  await assert.rejects(adapter.applyEngineeringOverrides(id, { material: { value: "PLA" } }, (await state(id)).token, "", ADMIN), /disabled/);
  await db.exec("update manufacturing.write_control set enabled=true");
  await sql("update manufacturing.requirements set obsolete=true, obsoletion_version=1, obsoletion_changed_at=now(), obsoletion_origin='manual' where id=$1", [id]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { quantity: { value: 1 } }, (await state(id)).token, "", ADMIN), /obsolete/);
  await sql("update manufacturing.requirements set obsolete=false, obsoletion_version=2 where id=$1", [id]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { routing: { value: ["Milling Machine", null, "Lathe", null] } },
    (await state(id)).token, "", ADMIN), /without gaps/);
});

test("the RPC refuses engineering changes without a matching override and work-discarding reroutes", async () => {
  const { id, key } = await requirement({ machines: ["Milling Machine"] });
  const current = await state(id);
  const write = (await sql<{ state: { token: string } }>("select public.manufacturing_write_state() state"))[0].state;
  const call = (changes: unknown[], overrides: unknown[] = []) => sql(`select public.manufacturing_apply_engineering_overrides(
      $1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb,'[]'::jsonb,'',null) result`,
  [crypto.randomUUID(), ADMIN.id, write.token, current.token, id, JSON.stringify(overrides), JSON.stringify(changes)]);
  await assert.rejects(call([{ entity: "requirements", id, patch: { required_quantity: 9 } }]), /only change through an override/);
  await assert.rejects(call([{ entity: "requirements", id, patch: { active_in_bom: false } }]), /Invalid engineering override change/);
  await sql("update manufacturing.operations set completed_quantity=1, status='Ready' where operation_key=$1", [`${key}|OP1`]);
  const write2 = (await sql<{ state: { token: string } }>("select public.manufacturing_write_state() state"))[0].state;
  const opId = (await ops(id))[0].id;
  await assert.rejects(sql(`select public.manufacturing_apply_engineering_overrides($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb,'[]'::jsonb,'',null)`,
    [crypto.randomUUID(), ADMIN.id, write2.token, current.token, id,
      JSON.stringify([{ entity: "requirements", row_id: id, field: "machine_op1", action: "set", value: "Lathe" }]),
      JSON.stringify([{ entity: "requirements", id, patch: { machine_op1: "Lathe" } }, { entity: "operations", id: opId, patch: { machine: "Lathe" } }])]),
  /recorded work/);
  for (const signature of ["manufacturing_apply_engineering_overrides(uuid,uuid,text,text,bigint,jsonb,jsonb,jsonb,text,jsonb)",
    "manufacturing_set_attachment_override(uuid,uuid,text,bigint,text,jsonb,text)", "manufacturing_engineering_override_state(bigint)"]) {
    assert.equal((await sql<{ allowed: boolean }>(`select has_function_privilege('authenticated','public.${signature}','execute') allowed`))[0].allowed, false);
    assert.equal((await sql<{ allowed: boolean }>(`select has_function_privilege('service_role','public.${signature}','execute') allowed`))[0].allowed, true);
  }
});

test("replacement files take precedence over synced files, survive re-exports, and revert", async () => {
  const { id } = await requirement({ part: 2 });
  const synced = "a".repeat(64);
  const replacement = "b".repeat(64);
  await sql(`insert into manufacturing.attachments(part_id,kind,position,source_url,source_metadata,original_name,content_type,
      byte_size,sha256,storage_bucket,storage_path,verified_at)
    values(2,'step',0,'https://onshape.test/1','{}','P-2.step','application/step',10,$1,'manufacturing-files',$2,now())`,
  [synced, `sha256/aa/${synced}.step`]);
  await sql(`insert into manufacturing.part_previews(part_id,source_attachment_id,source_sha256,generator,generator_version,content_type,
      byte_size,sha256,storage_bucket,storage_path,verified_at)
    select 2,id,sha256,'occt','1','model/gltf-binary',5,$1,'manufacturing-files',$2,now() from manufacturing.attachments where part_id=2`,
  ["c".repeat(64), `sha256/cc/${"c".repeat(64)}.glb`]);
  const file = { name: "P-2 fixed.step", sha256: replacement, byteSize: 20 };
  await assert.rejects(adapter.setAttachmentOverride(id, "step", file, (await state(id)).token, "", ADMIN), /transaction failed/);
  await sql("insert into storage.objects values('manufacturing-files',$1),('manufacturing-files',$2)",
    [`sha256/bb/${replacement}.step`, `sha256/aa/${synced}.step`]);
  await assert.rejects(adapter.setAttachmentOverride(id, "step", { ...file, sha256: synced }, (await state(id)).token, "", ADMIN),
    /matches the Onshape export/);
  await adapter.setAttachmentOverride(id, "step", file, (await state(id)).token, "Wrong configuration exported", ADMIN);

  const resolved = (await sql<{ file: { name: string; sha256: string } }>("select public.manufacturing_file_for_requirement($1,'step') file", [id]))[0].file;
  assert.deepEqual([resolved.name, resolved.sha256], ["P-2 fixed.step", replacement]);
  const manifest = (await sql<{ m: Array<{ part_id: number; original_name: string; override: boolean }> }>("select public.manufacturing_attachment_manifest() m"))[0].m;
  assert.deepEqual(manifest.filter((entry) => entry.part_id === 2).map((entry) => [entry.original_name, entry.override]), [["P-2 fixed.step", true]]);
  assert.equal((await sql("select public.manufacturing_preview_for_requirement($1) preview", [id]))[0].preview, null);
  // Assembly-derived previews stay a fallback for unreplaced parts, but never stand in for a replacement.
  const assemblyGlb = "9".repeat(64);
  await sql(`insert into manufacturing.assembly_part_previews(part_id,source_name,source_sha256,source_mesh_index,matched_name,byte_size,
    sha256,storage_bucket,storage_path,verified_at) values(2,'asm.glb',$1,0,'P-2',5,$1,'manufacturing-files',$2,now()),
    (1,'asm.glb',$1,0,'P-1',5,$1,'manufacturing-files',$2,now())`, [assemblyGlb, `sha256/99/${assemblyGlb}.glb`]);
  assert.equal((await sql("select public.manufacturing_preview_for_requirement($1) preview", [id]))[0].preview, null);
  const unreplaced = await requirement({ part: 1 });
  assert.equal((await sql<{ p: { sha256: string } }>("select public.manufacturing_preview_for_requirement($1) p", [unreplaced.id]))[0].p.sha256, assemblyGlb);

  // A new Onshape export replaces the synced catalog row but not the correction.
  await sync(`update manufacturing.attachments set sha256='${"d".repeat(64)}', storage_path='sha256/dd/${"d".repeat(64)}.step' where part_id=2`);
  assert.equal((await sql<{ file: { sha256: string } }>("select public.manufacturing_file_for_requirement($1,'step') file", [id]))[0].file.sha256, replacement);
  const current = await state(id);
  assert.equal(current.file_overrides[0].reason, "Wrong configuration exported");
  assert.equal(current.files[0].sha256, "d".repeat(64));

  await adapter.setAttachmentOverride(id, "step", null, current.token, "", ADMIN);
  assert.equal((await sql<{ file: { sha256: string } }>("select public.manufacturing_file_for_requirement($1,'step') file", [id]))[0].file.sha256, "d".repeat(64));
  await assert.rejects(adapter.setAttachmentOverride(id, "step", null, (await state(id)).token, "", ADMIN), /has not been replaced/);
});

test("part name and description corrections flow to Slack context and retire when Onshape agrees", async () => {
  await sql("insert into manufacturing.parts(id,part_number,name,description,material,last_synced_at) values(3,'P-3','Old name','Old text','6061',now())");
  const { id } = await requirement({ part: 3 });
  const result = await adapter.applyEngineeringOverrides(id, { name: { value: "Intake roller" }, description: { value: "Hex bore" } },
    (await state(id)).token, "", ADMIN);
  assert.equal(result.notificationContext.partName, "Intake roller");
  assert.equal(result.notificationContext.partNumber, "P-3");
  assert.equal(result.notificationContext.routingChanged, false);
  assert.deepEqual([(await row("parts", 3)).name, (await row("parts", 3)).description], ["Intake roller", "Hex bore"]);
  await sync("update manufacturing.parts set name='Intake roller', description='Old text', last_synced_at=clock_timestamp() where id=3");
  assert.deepEqual((await state(id)).overrides.map((override) => override.field), ["description"]);
  assert.equal((await row("parts", 3)).description, "Hex bore");
  await assert.rejects(adapter.applyEngineeringOverrides(id, { name: { value: "  " } }, (await state(id)).token, "", ADMIN), /Enter a part name/);
});

test("off-the-shelf parts retire routing and finishing, stay retired across syncs, and restore on demand", async () => {
  const { id, key } = await requirement({ machines: ["Haas CNC", "Tapping"], finishing: "Red", quantity: 2, part: 3 });
  await sql(`insert into manufacturing.operations(operation_key,requirement_id,operation_number,machine,work_type,active_in_routing,
    status,claimed_quantity,completed_quantity,quantity_ledger) values($1,$2,'OP1','Haas CNC','CAM',true,'Ready',0,0,'[]')`, [`${key}|CAM|OP1`, id]);
  await sql("update manufacturing.operations set status='Planned' where operation_key=$1", [`${key}|OP1`]);

  await sql("update manufacturing.operations set claimed_quantity=1, status='In Progress' where operation_key=$1", [`${key}|OP2`]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { offTheShelf: { value: true } }, (await state(id)).token, "", ADMIN), /OP2 \(Tapping\) has recorded work/);
  await sql("update manufacturing.operations set claimed_quantity=0, status='Planned' where operation_key=$1", [`${key}|OP2`]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { offTheShelf: { value: true }, routing: { value: ["Lathe", null, null, null] } },
    (await state(id)).token, "", ADMIN), /separately/);

  const bought = await adapter.applyEngineeringOverrides(id, { offTheShelf: { value: true } }, (await state(id)).token, "Buying from McMaster", ADMIN);
  assert.equal(bought.notificationContext.routingChanged, true);
  assert.deepEqual(bought.changes, [{ field: "Off-the-shelf", from: "No", to: "Yes" }]);
  assert.equal((await ops(id)).filter((operation) => operation.active_in_routing).length, 0);
  assert.equal((await sql("select active from manufacturing.finishing where requirement_id=$1", [id]))[0].active, false);
  const marked = await row("requirements", id);
  assert.deepEqual([marked.off_the_shelf, marked.off_the_shelf_changed_by, marked.status], [true, "Alex A.", "Ready for Manufacturing"]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { finishing: { value: "Black" } }, (await state(id)).token, "", ADMIN), /back to manufactured/);

  // The sync re-sends the routing and finishing; they are retired again in the same transaction.
  await sync(`update manufacturing.operations set active_in_routing=true where requirement_id=${id} and work_type='Manufacturing';
    update manufacturing.finishing set active=true where requirement_id=${id};
    insert into manufacturing.operations(operation_key,requirement_id,operation_number,machine,work_type,active_in_routing)
      values('${key}|OP3',${id},'OP3','Bandsaw','Manufacturing',true);`);
  assert.equal((await ops(id)).filter((operation) => operation.active_in_routing).length, 0);
  assert.equal((await sql("select active from manufacturing.finishing where requirement_id=$1", [id]))[0].active, false);
  assert.equal((await row("requirements", id)).off_the_shelf, true);

  const corrections = (await adapter.readEngineeringCorrections()).filter((correction) => correction.requirement_id === id);
  assert.deepEqual(corrections.map((correction) => [correction.kind, correction.part_number, correction.assembly_number, correction.updated_by_name]),
    [["off_the_shelf", "P-3", "A-1", "Alex A."]]);

  await adapter.applyEngineeringOverrides(id, { offTheShelf: { value: false } }, (await state(id)).token, "", ADMIN);
  const restored = (await ops(id)).filter((operation) => operation.active_in_routing);
  assert.deepEqual(restored.map((operation) => [operation.operation_number, operation.work_type, operation.machine, operation.status]),
    [["OP1", "Manufacturing", "Haas CNC", "Planned"], ["OP1", "CAM", "Haas CNC", "Ready"], ["OP2", "Manufacturing", "Tapping", "Planned"]]);
  assert.equal((await sql("select active from manufacturing.finishing where requirement_id=$1", [id]))[0].active, true);
  assert.deepEqual([(await row("requirements", id)).off_the_shelf, (await row("requirements", id)).status], [false, "Ready for CAM"]);
  assert.deepEqual((await sql("select action from manufacturing.engineering_override_events where field='off_the_shelf' and row_id=$1 order by id", [id]))
    .map((event) => event.action), ["set", "cleared"]);
});

test("the corrections report lists field, file, and requirement-level corrections with their Onshape values", async () => {
  const { id } = await requirement({ quantity: 6 });
  await adapter.applyEngineeringOverrides(id, { quantity: { value: 3 } }, (await state(id)).token, "Spare set not needed", ADMIN);
  const plate = await requirement({ part: 2 });
  const fixed = "2".repeat(64);
  await sql("insert into storage.objects values('manufacturing-files',$1)", [`sha256/22/${fixed}.step`]);
  await adapter.setAttachmentOverride(plate.id, "step", { name: "P-2 fixed.step", sha256: fixed, byteSize: 12 }, (await state(plate.id)).token, "", ADMIN);
  const list = await adapter.readEngineeringCorrections();
  const quantity = list.find((correction) => correction.requirement_id === id && correction.field === "required_quantity")!;
  assert.deepEqual([quantity.kind, quantity.value, quantity.synced_value, quantity.reason, quantity.part_number],
    ["field", 3, 6, "Spare set not needed", "P-1"]);
  const file = list.find((correction) => correction.kind === "file" && correction.part_number === "P-2")!;
  assert.equal(file.requirement_id, null);
  assert.deepEqual([(file.value as { name: string }).name, (file.synced_value as { name: string }).name], ["P-2 fixed.step", "P-2.step"]);
});

test("replacement STEPs resolve their own registered preview and stop when the file changes", async () => {
  const { id } = await requirement({ part: 2 });
  const replacement = "e".repeat(64);
  await sql("insert into storage.objects values('manufacturing-files',$1)", [`sha256/ee/${replacement}.step`]);
  await adapter.setAttachmentOverride(id, "step", { name: "P-2 v2.step", sha256: replacement, byteSize: 30 }, (await state(id)).token, "", ADMIN);
  assert.equal((await state(id)).file_overrides[0].preview, false);
  const [source] = (await sql<{ s: Array<{ override_id: number; sha256: string; preview_sha256: string | null }> }>(
    "select public.manufacturing_override_step_preview_sources() s"))[0].s;
  assert.deepEqual([source.sha256, source.preview_sha256], [replacement, null]);
  const glb = "f".repeat(64);
  const register = (sha = replacement) => sql(`select public.manufacturing_register_override_preview($1,$2,'occt','1','model/gltf-binary',9,$3,
    'manufacturing-files',$4,now())`, [source.override_id, sha, glb, `sha256/ff/${glb}.glb`]);
  await assert.rejects(register("0".repeat(64)), /changed while its preview/);
  await register();
  assert.equal((await state(id)).file_overrides[0].preview, true);
  const preview = (await sql<{ p: { sha256: string; source_sha256: string } }>("select public.manufacturing_preview_for_requirement($1) p", [id]))[0].p;
  assert.deepEqual([preview.sha256, preview.source_sha256], [glb, replacement]);

  const newer = "1".repeat(64);
  await sql("insert into storage.objects values('manufacturing-files',$1)", [`sha256/11/${newer}.step`]);
  await adapter.setAttachmentOverride(id, "step", { name: "P-2 v3.step", sha256: newer, byteSize: 31 }, (await state(id)).token, "", ADMIN);
  assert.equal((await sql("select public.manufacturing_preview_for_requirement($1) p", [id]))[0].p, null);
  assert.equal((await state(id)).file_overrides[0].preview, false);
  for (const signature of ["manufacturing_engineering_correction_list()", "manufacturing_override_step_preview_sources()",
    "manufacturing_register_override_preview(bigint,text,text,text,text,bigint,text,text,text,timestamptz)"]) {
    assert.equal((await sql<{ allowed: boolean }>(`select has_function_privilege('authenticated','public.${signature}','execute') allowed`))[0].allowed, false);
  }
});

test("requirement history lists shop writes, corrections, and QC reviews for only that requirement", async () => {
  // A fresh part: part-level corrections appear on every requirement for that part.
  const part = (await sql<{ id: number }>("insert into manufacturing.parts(id,part_number,name,last_synced_at) values(90,'P-H','Hinge',now()) returning id"))[0].id;
  const { id } = await requirement({ quantity: 2, part });
  const other = await requirement({ quantity: 1, part });
  await adapter.applyEngineeringOverrides(id, { quantity: { value: 3 } }, (await state(id)).token, "Mirror part missing", ADMIN);
  await adapter.applyEngineeringOverrides(other.id, { quantity: { value: 5 } }, (await state(other.id)).token, "", ADMIN);
  const [operation] = await ops(id);
  const write = (await sql<{ state: { token: string } }>("select public.manufacturing_write_state() state"))[0].state;
  await sql(`select public.manufacturing_commit($1::uuid,$2::uuid,'claim',$3,$4::jsonb,null,null)`, [crypto.randomUUID(), MACHINIST, write.token,
    JSON.stringify([{ entity: "operations", id: operation.id, patch: { status: "In Progress", claimed_quantity: 1,
      quantity_ledger: JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 1, completed: 0 }]) } }])]);
  await sql(`insert into public.quality_control(production_requirement_id,result,notes,reviewed_by,reviewed_at)
    values($1,'failed','Burr on edge',$2,now())`, [id, ADMIN.id]);

  const history = await adapter.readRequirementHistory(id);
  assert.ok(history);
  assert.deepEqual(history.writes.map((entry) => [entry.action, entry.actor]), [["claim", "Sam M."], ["engineering_override", "Alex A."]]);
  const claim = history.writes[0].rows.find((row) => row.entity === "operations")!;
  assert.deepEqual([claim.operationNumber, claim.machine, claim.changes.claimed_quantity], ["OP1", "Milling Machine", [0, 1]]);
  assert.ok(!("updated_at" in claim.changes));
  assert.deepEqual(history.writes[1].corrections.map((correction) => [correction.field, correction.action, correction.value, correction.reason]),
    [["required_quantity", "set", 3, "Mirror part missing"]]);
  assert.deepEqual(history.reviews.map((review) => [review.result, review.reviewer, review.notes]), [["failed", "Alex A.", "Burr on edge"]]);
  assert.equal(await adapter.readRequirementHistory(999_999), null);
  assert.equal((await sql<{ allowed: boolean }>("select has_function_privilege('authenticated','public.manufacturing_requirement_history(bigint,integer)','execute') allowed"))[0].allowed, false);
});

test("QC can move to after an earlier operation, re-planning readiness, and back to the default", async () => {
  const { id, key } = await requirement({ quantity: 2, machines: ["Milling Machine", "Tapping", "Threaded Insert"] });
  await sql(`update manufacturing.operations set status='Complete', completed_at=now(), completed_quantity=2, quantity_ledger=$2
    where operation_key=$1`, [`${key}|OP1`, JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 0, completed: 2 }])]);
  await sql(`update manufacturing.operations set status='Ready' where operation_key=$1`, [`${key}|OP2`]);

  await assert.rejects(adapter.applyEngineeringOverrides(id, { qcAfterOperation: { value: 4 } }, (await state(id)).token, "", ADMIN), /routing has no OP4/);
  const moved = await adapter.applyEngineeringOverrides(id, { qcAfterOperation: { value: 1 } }, (await state(id)).token, "Inspect before tapping", ADMIN);
  assert.deepEqual(moved.changes, [{ field: "QC and finishing", from: "After all operations except threaded inserts", to: "After OP1" }]);
  assert.deepEqual([(await row("requirements", id)).status, (await row("requirements", id)).qc_after_operation], ["Ready for QC", 1]);
  assert.deepEqual((await ops(id)).map((operation) => operation.status), ["Complete", "Planned", "Planned"]);
  assert.equal((await state(id)).requirement?.qc_after_operation, 1);

  const history = await adapter.readRequirementHistory(id);
  assert.deepEqual(history?.writes[0].corrections.map((correction) => [correction.field, correction.action, correction.value, correction.reason]),
    [["qc_after_operation", "set", 1, "Inspect before tapping"]]);

  await adapter.applyEngineeringOverrides(id, { qcAfterOperation: { value: null } }, (await state(id)).token, "", ADMIN);
  assert.deepEqual([(await row("requirements", id)).status, (await row("requirements", id)).qc_after_operation], ["Ready for Manufacturing", null]);
  assert.deepEqual((await ops(id)).map((operation) => operation.status), ["Complete", "Ready", "Planned"]);
  assert.deepEqual((await sql("select action from manufacturing.engineering_override_events where field='qc_after_operation' and row_id=$1 order by id", [id]))
    .map((event) => event.action), ["set", "cleared"]);

  await sql(`update manufacturing.operations set status='In Progress', claimed_quantity=1, quantity_ledger=$2 where operation_key=$1`,
    [`${key}|OP2`, JSON.stringify([{ userId: MACHINIST, name: "Sam M.", claimed: 1, completed: 0 }])]);
  await assert.rejects(adapter.applyEngineeringOverrides(id, { qcAfterOperation: { value: 1 } }, (await state(id)).token, "", ADMIN), /OP2 \(Tapping\) is claimed/);

  const passed = await passedPart({ quantity: 1 });
  await assert.rejects(adapter.applyEngineeringOverrides(passed.id, { qcAfterOperation: { value: 1 } }, (await state(passed.id)).token, "", ADMIN),
    /Undo the passed QC review before changing when QC happens/);
});

test("the SQL QC point matches the app and drives routing initialization and approved-quantity rewrites", async () => {
  const post = async (machine: string, operation: string, point: number | null) =>
    (await sql<{ post: boolean }>("select manufacturing.is_post_qc_operation($1,$2,$3::smallint) post", [machine, operation, point]))[0].post;
  assert.deepEqual([await post("Threaded Insert", "OP3", null), await post("Tapping", "OP2", null), await post("Tapping", "OP2", 1),
    await post("Threaded Insert", "OP2", 2)], [true, false, true, false]);

  // A new route whose OP1 is a threaded insert is only triageable once QC moves after OP1.
  const [fresh] = await sql<{ id: number }>(`insert into manufacturing.requirements(production_key,part_id,assembly_id,source_root,
      required_part_revision,source_assembly_revision,active_in_bom,required_quantity,finishing,machine_op1,qc_after_operation,last_synced_at)
    values('ROOT|A|A-1|P-QC|default|v2',1,1,'ROOT','A','A',true,1,'None','Threaded Insert',1,now()) returning id`);
  await sql(`insert into manufacturing.operations(operation_key,requirement_id,operation_number,machine,work_type,active_in_routing)
    values('ROOT|A|A-1|P-QC|default|v2|OP1',$1,'OP1','Threaded Insert','Manufacturing',true)`, [fresh.id]);
  await sql("select manufacturing.initialize_synced_routing()");
  assert.deepEqual([(await ops(fresh.id))[0].status, (await row("requirements", fresh.id)).status], ["Ready", "Ready for Manufacturing"]);

  // "QC approved" rewrites only the inspected operations.
  const { id } = await passedPart({ quantity: 2, machines: ["Milling Machine", "Tapping"] });
  await sql("update manufacturing.requirements set qc_after_operation=1 where id=$1", [id]);
  await adapter.applyEngineeringOverrides(id, { quantity: { value: 3 }, passedQcQuantity: "approved" }, (await state(id)).token, "", ADMIN);
  assert.deepEqual((await ops(id)).map((operation) => [operation.status, Number(operation.completed_quantity)]), [["Complete", 3], ["Ready", 2]]);
});
