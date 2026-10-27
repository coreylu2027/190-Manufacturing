// Shared setup for the SQL tests, which run in in-memory PostgreSQL (PGlite)
// and never contact Supabase or Onshape.
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

/** Stand-ins for what a hosted Supabase project provides, plus the cutover staging table the schema still references. */
export const SUPABASE_STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
  create function auth.uid() returns uuid language sql stable as 'select null::uuid';
  create schema realtime;
  create table realtime.messages(topic text not null, extension text not null default 'broadcast', payload jsonb,
    event text, private boolean not null default true);
  create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
    returns void language sql security definer set search_path = ''
    as $$ insert into realtime.messages(topic, extension, payload, event, private) values ($3, 'broadcast', $1, $2, $4) $$;
  create publication supabase_realtime;
  create schema storage;
  create table storage.buckets(id text primary key, public boolean not null default false);
  create table storage.objects(bucket_id text references storage.buckets(id), name text, primary key(bucket_id, name));
  insert into storage.buckets values('manufacturing-files', false);
  create schema frc190_baserow_stage; create table frc190_baserow_stage.snapshots(id uuid primary key);
`;

/** The public tables the 2026-09-01..04 migrations create, for suites that install only the manufacturing schema. */
export const PUBLIC_TABLE_STUBS = `
  create table public.profiles(id uuid primary key, display_name text, approved boolean, role text);
  create type public.quality_result as enum ('passed','failed');
  create table public.quality_control(id bigint generated always as identity primary key,
    production_requirement_id bigint, operation_id bigint, result public.quality_result,
    notes text, rejected_quantity integer, reviewed_by uuid, reviewed_at timestamptz, updated_at timestamptz);
`;

/** The engineering sync's run table alone, for suites that install only the migrations hooking its status changes. */
export const ENGINEERING_SYNC_STUB = `create table manufacturing.engineering_sync_runs(id integer primary key, status text,
  started_at timestamptz not null default clock_timestamp())`;

/**
 * The schema in an order that installs cleanly on a fresh database; the
 * production-writes runbook gives the same order. SUPABASE_STUBS stands in for
 * supabase/staging. The engineering-sync API comes before the migrations that
 * patch its apply function or hook its run status.
 */
const SCHEMA_ORDER = [
  "migrations/202609010001_admin_approval_and_qc", "migrations/202609010002_profile_permissions",
  "migrations/202609010003_notifications", "migrations/202609010004_notification_realtime",
  "migrations/202609010005_profile_last_seen", "migrations/202609040001_requirement_level_qc",
  "migrations/202609040002_qc_legacy_compatibility", "migrations/202609050001_qc_storage_locations",
  "migrations/20260905165307_part_locations", "migrations/20260909174808_qc_rejected_quantities",
  "production/20260905_normalized_manufacturing", "production/20260905_manufacturing_writes",
  "production/20260905_qc_storage_locations", "production/20260905_part_locations",
  "production/20260905_manufacturing_attachments", "production/20260906_manufacturing_realtime",
  "production/20260906_manufacturing_shared_cache", "production/20260907_manufacturing_part_previews",
  "production/20260909_requirement_notes", "production/20260909_qc_rejected_quantities",
  "migrations/20260916162511_printer_locations", "production/20260916_operation_locations",
  "production/20260906_onshape_engineering_sync", "migrations/20260906143937_preserve_cam_operations",
  "production/20260910_preserve_unchanged_part_revisions", "migrations/20260926000000_cots_parts",
  "migrations/20260910031802_assembly_glb_previews", "migrations/20260911033920_initialize_synced_routing",
  "migrations/20260918162451_requirement_obsoletion", "migrations/20260919030147_obsolete_work_notifications",
  "migrations/20260919222149_obsolete_removed_requirements", "migrations/20260919223625_hide_obsolete_requirements",
  "migrations/20260922190000_admin_engineering_overrides", "migrations/20260923040000_passed_qc_quantity_corrections",
  "migrations/20260923170000_requirement_history", "migrations/20260924000000_configurable_qc_point",
  "migrations/20260926010000_restored_requirement_robot_location", "migrations/20260929120000_engineering_sync_review",
  "migrations/20261018000000_lock_down_public_tables",
];

export async function createDatabase(setup: string) {
  const db = new PGlite();
  const sql = async <T extends object = Record<string, unknown>>(query: string, params: unknown[] = []) =>
    (await db.query<T>(query, params)).rows;
  const install = async (path: string) => db.exec(await readFile(new URL(`../../${path}`, import.meta.url), "utf8"));
  await db.exec(setup);
  return { db, sql, install };
}

/** A database with the complete current schema, installed in SCHEMA_ORDER. */
export async function createSchemaDatabase() {
  const database = await createDatabase(SUPABASE_STUBS);
  for (const file of SCHEMA_ORDER) await database.install(`supabase/${file}.sql`);
  return database;
}
