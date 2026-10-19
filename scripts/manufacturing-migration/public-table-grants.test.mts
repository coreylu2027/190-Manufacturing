// Runs in isolated PostgreSQL/WASM; never contacts Supabase.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

async function database() {
  const db = new PGlite();
  const install = async (path: string) => db.exec(await readFile(new URL(`../../${path}`, import.meta.url), "utf8"));
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    -- Supabase's default: every new public table is fully granted to the API roles.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  for (const migration of ["202609010001_admin_approval_and_qc", "202609010002_profile_permissions",
    "202609010003_notifications", "202609010005_profile_last_seen", "202609040001_requirement_level_qc",
    "202609040002_qc_legacy_compatibility"]) await install(`supabase/migrations/${migration}.sql`);
  await db.query(`insert into auth.users(id, email, raw_user_meta_data) values
    ($1, 'alice@example.com', '{"full_name":"Alice A."}'), ($2, 'bob@example.com', '{"full_name":"Bob B."}')`, [ALICE, BOB]);
  await db.query("insert into public.notifications(recipient_id, type, title, message) values ($1, 'test', 'Hello', 'Hi')", [ALICE]);
  const lockDown = () => install("supabase/migrations/20261018000000_lock_down_public_tables.sql");
  /** Runs a statement as a signed-in user through the API role, then returns to the superuser. */
  async function as(role: "anon" | "authenticated", statement: string, params: unknown[] = []) {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [role === "authenticated" ? ALICE : ""]);
    await db.exec(`set role ${role}`);
    try { return (await db.query(statement, params)).rows; }
    finally { await db.exec("reset role"); }
  }
  return { db, lockDown, as };
}

test("with Supabase default grants, a signed-in user can approve and promote themselves", async () => {
  const { db, as } = await database();
  await as("authenticated", "update public.profiles set approved = true, role = 'admin', display_name = 'Bob B.' where id = $1", [ALICE]);
  const [profile] = (await db.query<{ approved: boolean; role: string }>("select approved, role from public.profiles where id = $1", [ALICE])).rows;
  assert.deepEqual(profile, { approved: true, role: "admin" });
});

test("the lockdown leaves users only reading their own rows and stamping last seen / read", async () => {
  const { db, lockDown, as } = await database();
  await lockDown();
  for (const statement of [
    "update public.profiles set approved = true where id = $1",
    "update public.profiles set role = 'admin' where id = $1",
    "update public.profiles set display_name = 'Bob B.' where id = $1",
    "update public.notifications set title = 'Changed' where recipient_id = $1",
  ]) await assert.rejects(as("authenticated", statement, [ALICE]), /permission denied/, statement);
  await assert.rejects(as("authenticated", "insert into public.profiles(id, email, display_name) values (gen_random_uuid(), '', 'X')"), /permission denied/);
  await assert.rejects(as("authenticated", "select * from public.quality_control"), /permission denied/);
  await assert.rejects(as("anon", "select * from public.profiles"), /permission denied/);
  await assert.rejects(as("authenticated", "select setval('public.quality_control_id_seq', 1)"), /permission denied/);

  assert.deepEqual((await as("authenticated", "select id from public.profiles")).map((row) => (row as { id: string }).id), [ALICE]);
  await as("authenticated", "update public.profiles set last_seen_at = now() where id = $1", [ALICE]);
  await as("authenticated", "update public.notifications set read_at = now() where recipient_id = $1", [ALICE]);
  assert.equal((await as("authenticated", "select id from public.notifications")).length, 1);
  const [profile] = (await db.query<{ approved: boolean; role: string; seen: boolean }>(
    "select approved, role, last_seen_at is not null as seen from public.profiles where id = $1", [ALICE])).rows;
  assert.deepEqual(profile, { approved: false, role: "machinist", seen: true });
});
