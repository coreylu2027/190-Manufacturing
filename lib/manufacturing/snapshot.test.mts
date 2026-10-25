import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import * as qualityControl from "../quality-control.ts";
import { loadModule } from "../test-module-loader.mts";
import * as supabaseAdapter from "./supabase-adapter.ts";
import * as writeAdapter from "./write-adapter.ts";

/**
 * One normalized dataset that reaches every projected field: identity
 * fallbacks, obsoletion and visibility, COTS, QC points, finishing, quantity
 * ledgers with legacy fallbacks, attachments, CAM dependencies, duplicate and
 * inactive routing, and QC reviews with a retraction.
 */
const extra = { source_row: { Part: [{ id: 1, value: "stale" }] }, created_at: "2026-09-01T00:00:00+00:00" };
const rows: Record<string, Array<Record<string, unknown> & { id: number }>> = {
  assemblies: [
    { id: 1, ...extra, assembly_number: "A-ROOT", active: true },
    { id: 2, assembly_number: " A-SUB ", active: true },
    { id: 3, assembly_number: null },
  ],
  parts: [
    { id: 10, ...extra, part_number: "P-100", name: "Bracket", material: "6061", revision: "B", drawing_url: "https://cad.example/d/10", vendor: null, cots: false },
    { id: 11, part_number: "  ", name: null, material: " ", revision: null, drawing_url: "", cots: null },
    { id: 12, part_number: "WCP-0215", name: "Bearing", vendor: "WCP", material: "Steel", revision: "  ", cots: true },
    { id: 13, part_number: "WCP-0300", name: "Routed bearing", cots: true },
  ],
  requirements: [
    { id: 100, ...extra, production_key: "A-ROOT|P-100", part_id: 10, assembly_id: 1, required_quantity: 4, finishing: "Black",
      status: "Ready for Finishing", qc_outcome: "Passed", qc_after_operation: 1, source_root: "A-ROOT", source_document: "Doc A",
      source_assembly_revision: "7", required_part_revision: " C ", configuration: "Main", bom_positions: "2, 5", machinist: "Alex A.",
      active_in_bom: true, engineering_changed: true, disposition: "Use As Is", production_notes: " Deburr ", onshape_url: "https://cad.example/r/100",
      part_location: "Shelf 2", location_updated_by: "Morgan M.", location_updated_at: "2026-09-05T15:00:00+00:00",
      obsolete: false, hidden: false, off_the_shelf: false, visibility_version: 0, obsoletion_version: 0 },
    { id: 101, production_key: "A-ROOT|P-101", part_id: 11, assembly_id: 2, required_quantity: null, finishing: "None", status: null,
      source_root: "A-ROOT", source_document: "Doc B", active_in_bom: false, obsolete: true, obsoletion_version: 2,
      obsoletion_changed_at: "2026-09-20T01:00:00+00:00", obsoletion_changed_by: "Sam S.", obsoletion_origin: "automatic",
      obsolete_replacement_id: 100, hidden: true, visibility_version: 3, part_location: "Not a location" },
    { id: 102, production_key: null, part_id: null, assembly_id: null, required_quantity: 2, qc_outcome: "Failed", status: "Ready for QC",
      active_in_bom: true, off_the_shelf: true, source_root: "A-ROOT", source_document: "Doc A" },
    { id: 103, production_key: "A-ROOT|WCP-0215", part_id: 12, assembly_id: 1, required_quantity: 6, active_in_bom: true,
      source_root: "A-ROOT", source_document: "Doc A", part_location: "Clarke 1", location_updated_by: "Sam S.",
      location_updated_at: "2026-09-26T00:00:00+00:00", onshape_url: " https://cad.example/r/103 ", status: "Complete" },
    { id: 104, part_id: 12, assembly_id: 1, required_quantity: 1, active_in_bom: false },
    { id: 105, part_id: 12, assembly_id: 2, required_quantity: 2, active_in_bom: false, obsolete: true, obsoletion_version: 1, obsoletion_origin: "manual" },
    { id: 106, part_id: 13, assembly_id: 1, required_quantity: 3, active_in_bom: true },
    { id: 107, production_key: "A-SUB|P-100", part_id: 10, assembly_id: 3, required_quantity: 2, finishing: null, status: "Ready for Manufacturing",
      qc_outcome: null, qc_after_operation: null, source_root: "A-SUB", source_document: "Doc C", active_in_bom: true },
  ],
  operations: [
    { id: 1000, ...extra, operation_key: "A-ROOT|P-100|OP1", requirement_id: 100, operation_number: "OP1", machine: "Haas CNC", work_type: "Manufacturing",
      active_in_routing: true, status: "Complete", machinist: "Alex A.", started_at: "2026-09-05T10:00:00+00:00", completed_at: "2026-09-05T12:00:00+00:00",
      claimed_quantity: 0, completed_quantity: 4, quantity_ledger: JSON.stringify([{ userId: "u-alex", name: "Alex A.", claimed: 0, completed: 4 }]) },
    { id: 1001, operation_key: "A-ROOT|P-100|OP1", requirement_id: 100, operation_number: "OP1", machine: "CAM", work_type: "CAM",
      active_in_routing: true, status: "Complete", machinist: "Casey C.", completed_quantity: 1, claimed_quantity: null,
      cam_program_path: " /cam/p100.nc ", cam_notes: "Use soft jaws" },
    { id: 1002, operation_key: "A-ROOT|P-100|OP2", requirement_id: 100, operation_number: "OP2", machine: "Lathe", work_type: "Manufacturing",
      active_in_routing: true, status: "Ready", quantity_ledger: "{not json" },
    { id: 1003, operation_key: "old-route|OP1", requirement_id: 100, operation_number: "OP1", machine: "Mill", work_type: "Manufacturing",
      active_in_routing: false, status: "Complete", completed_quantity: 4 },
    { id: 1004, operation_key: "A-ROOT|P-101|OP1", requirement_id: 101, operation_number: "OP1", machine: "Bambu 3D Printer", work_type: null,
      active_in_routing: false, status: "In Progress", machinist: "  Pat P.  ", claimed_quantity: null, completed_quantity: null },
    { id: 1005, operation_key: null, requirement_id: 102, operation_number: null, machine: null, work_type: "Manufacturing",
      active_in_routing: false, status: null, quantity_ledger: "[]" },
    { id: 1006, operation_key: "A-ROOT|WCP-0300|OP1", requirement_id: 106, operation_number: "OP1", machine: "Bambu 3D Printer", work_type: "Manufacturing",
      active_in_routing: true, status: "In Progress", machinist: "Riley R. (2)", quantity_ledger: JSON.stringify([
        { userId: "u-riley", name: "Riley R.", claimed: 2.7, completed: 0 }, { userId: "", name: "No id", claimed: 1 },
        { userId: "u-zero", name: "Zero", claimed: 0, completed: 0 }, "junk",
      ]) },
    { id: 1007, operation_key: "dup|OP1", requirement_id: 107, operation_number: "OP1", machine: "Haas CNC", work_type: "Manufacturing",
      active_in_routing: true, status: "Needs Rework", claimed_quantity: 1 },
    { id: 1008, operation_key: "dup|OP1", requirement_id: 107, operation_number: "OP1", machine: "Haas CNC", work_type: "Manufacturing",
      active_in_routing: true, status: "Planned" },
    { id: 1009, operation_key: "dup|OP2", requirement_id: 107, operation_number: "OP2", machine: "Threaded Insert", work_type: "Manufacturing",
      active_in_routing: true, status: "Ready" },
    { id: 1010, operation_key: "orphan|OP1", requirement_id: null, operation_number: "OP3", machine: "", work_type: "Manufacturing",
      active_in_routing: true, status: "Blocked" },
  ],
  finishing: [
    { id: 2000, ...extra, production_key: "A-ROOT|P-100", requirement_id: 100, color: "Black", required_quantity: 4, active: true,
      machinist: "Jordan J.", last_synced_at: "2026-09-04T00:00:00+00:00" },
    { id: 2001, production_key: "A-ROOT|P-101", requirement_id: 101, color: "Red", required_quantity: 2.6, active: false },
    { id: 2002, production_key: null, requirement_id: 107, color: null, required_quantity: null, active: true, machinist: null },
    { id: 2003, production_key: "missing", requirement_id: 999, color: "Blue", active: true },
    { id: 2004, production_key: "inactive", requirement_id: 102, color: "Blue", active: false },
  ],
};
const attachments = [
  { part_id: 10, kind: "drawing-pdf", position: 1, original_name: "P-100 REV C.pdf" },
  { part_id: 10, kind: "drawing-pdf", position: 0, original_name: "P-100 REV B.pdf" },
  { part_id: 10, kind: "step", position: 0, original_name: "P-100 REV B.step" },
  { part_id: 12, kind: "step", position: 2, original_name: "WCP-0215.step" },
];
const review = { operation_id: null, rejected_quantity: null, storage_location: null, location_updated_by: null, location_updated_at: null, updated_at: "2026-09-06T00:00:00+00:00" };
const reviews = [
  { ...review, id: 1, production_requirement_id: 100, result: "passed", notes: "Looks good", reviewed_by: "u-robin", reviewed_at: "2026-09-05T13:00:00+00:00", storage_location: "Clarke 2", location_updated_by: "u-morgan", location_updated_at: "2026-09-05T14:00:00+00:00" },
  { ...review, id: 2, production_requirement_id: 100, result: "failed", notes: "Bore oversized", rejected_quantity: 1, reviewed_by: "u-morgan", reviewed_at: "2026-09-05T11:00:00+00:00" },
  { ...review, id: 3, production_requirement_id: 107, result: "failed", notes: "Retracted failure", rejected_quantity: 2, reviewed_by: "u-robin", reviewed_at: "2026-09-06T09:00:00+00:00" },
  { ...review, id: 4, production_requirement_id: null, operation_id: 1004, result: "passed", notes: "Printed fine", reviewed_by: "u-unknown", reviewed_at: "2026-09-07T09:00:00+00:00" },
  { ...review, id: 5, production_requirement_id: 999, result: "failed", notes: "No routing", reviewed_by: "u-robin", reviewed_at: "2026-09-07T10:00:00+00:00" },
  { ...review, id: 6, production_requirement_id: 102, result: "failed", notes: "Wrong stock", rejected_quantity: 2, reviewed_by: "u-morgan", reviewed_at: "2026-09-07T11:00:00+00:00" },
];
const retractions = [{ review_id: 3 }];
const profiles = [{ id: "u-robin", display_name: "Robin R." }, { id: "u-morgan", display_name: "Morgan M." }];

function supabaseFetch(qualityReviews: typeof reviews) {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const rpc = url.pathname.split("/").at(-1);
    if (rpc === "manufacturing_data_version") return Response.json("42");
    if (rpc === "manufacturing_attachment_manifest") return Response.json(attachments);
    if (rpc === "manufacturing_write_state") {
      const { operations, requirements, finishing } = rows;
      return Response.json({ rows: { operations, requirements, finishing }, reviews: qualityReviews, retractions, token: "token" });
    }
    assert.equal(rpc, "manufacturing_read_entity");
    // Page in twos so pagination is part of the read.
    const entity = rows[url.searchParams.get("p_entity")!];
    const offset = Number(url.searchParams.get("p_offset"));
    return Response.json({ rows: entity.slice(offset, offset + 2), total: entity.length });
  };
}

// Reviews come from the write-state RPC; the admin client only resolves reviewer names.
function adminClient() {
  return {
    from: (table: string) => ({
      select: async (columns: string) => {
        assert.deepEqual([table, columns], ["profiles", "id, display_name"]);
        return { data: profiles, error: null };
      },
    }),
  };
}

interface Snapshot {
  qualityReviews: unknown[];
  operations: Array<{ requirementId: number | null; effectiveQcResult: string; qualityNotes: string; lastQualityFailure: { notes: string } | null }>;
}

function loadSnapshotModule(qualityReviews = reviews) {
  const config = { manufacturingSupabaseConfig: () => ({ url: "https://example.test", serviceKey: "test", fetch: supabaseFetch(qualityReviews) }) };
  const manufacturing = loadModule(new URL("./index.ts", import.meta.url),
    { "server-only": {}, "./supabase-adapter": supabaseAdapter, "./config": config, "./write-adapter": writeAdapter });
  const qualityServer = loadModule(new URL("../quality-control-server.ts", import.meta.url), {
    "server-only": {}, "./manufacturing": manufacturing, "./quality-control": qualityControl,
    "./supabase/admin": { createAdminClient: adminClient },
  });
  return loadModule<{ getCurrentManufacturingSnapshot(): Promise<{ version: string; snapshot: Snapshot }> }>(
    new URL("./cache.ts", import.meta.url), {
      "server-only": {}, "next/cache": { unstable_cache: (load: unknown) => load },
      "../quality-control": qualityControl, "../quality-control-server": qualityServer, "./index": manufacturing,
    });
}

test("the projected manufacturing snapshot matches its golden copy", async () => {
  const { version, snapshot } = await loadSnapshotModule().getCurrentManufacturingSnapshot();
  assert.equal(version, "42");
  // The Data Cache stores JSON, so compare the serialized form.
  const actual = JSON.parse(JSON.stringify(snapshot));
  const golden = new URL("./snapshot.golden.json", import.meta.url);
  if (process.env.UPDATE_GOLDEN) writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(readFileSync(golden, "utf8")));
});

test("QC uses every review past PostgREST's 1000-row max_rows cap", async () => {
  // 1001 failures, then a later pass; a capped select drops the pass and shows the part as failed.
  const manyReviews = Array.from({ length: 1002 }, (_, index) => ({
    ...review, id: index + 1, production_requirement_id: 100, result: index === 1001 ? "passed" : "failed",
    notes: `Review ${index + 1}`, rejected_quantity: index === 1001 ? null : 1, reviewed_by: "u-robin",
    reviewed_at: new Date(Date.UTC(2026, 8, 6) + index * 60_000).toISOString(),
  }));
  const { snapshot } = await loadSnapshotModule(manyReviews).getCurrentManufacturingSnapshot();
  assert.equal(snapshot.qualityReviews.length, 1002);
  const operation = snapshot.operations.find((candidate) => candidate.requirementId === 100)!;
  assert.equal(operation.effectiveQcResult, "passed");
  assert.equal(operation.qualityNotes, "Review 1002");
  assert.equal(operation.lastQualityFailure?.notes, "Review 1001");
});
