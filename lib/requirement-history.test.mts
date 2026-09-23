import test from "node:test";
import assert from "node:assert/strict";

import { buildRequirementHistory, type HistoryRow, type HistoryWrite, type RequirementHistoryPayload } from "./requirement-history.ts";

const op = (changes: HistoryRow["changes"], options: Partial<HistoryRow> = {}): HistoryRow => ({
  entity: "operations", rowId: 1, created: false, operationNumber: "OP1", machine: "Haas CNC", workType: "Manufacturing", changes, ...options,
});
const requirementRow = (changes: HistoryRow["changes"]): HistoryRow => ({
  entity: "requirements", rowId: 9, created: false, operationNumber: null, machine: null, workType: null, changes,
});
const write = (action: string, at: string, rows: HistoryRow[], extra: Partial<HistoryWrite> = {}): HistoryWrite => ({
  requestId: `${action}:${at}`, action, at, actor: "Sam M.", rows, corrections: [], ...extra,
});
const payload = (overrides: Partial<RequirementHistoryPayload>): RequirementHistoryPayload => ({
  requirementId: 9, writes: [], syncEvents: [], reviews: [], ...overrides,
});

test("shop work reads as quantities on a labeled operation, newest first, with requirement status changes", () => {
  const entries = buildRequirementHistory(payload({ writes: [
    write("claim", "2026-09-20T10:00:00Z", [op({ claimed_quantity: [0, 2], status: ["Ready", "In Progress"] })]),
    write("complete", "2026-09-20T12:00:00Z", [op({ claimed_quantity: [2, 0], completed_quantity: [0, 2] }),
      requirementRow({ status: ["On Machine", "Ready for QC"] })]),
    write("claim", "2026-09-20T11:00:00Z", [op({ claimed_quantity: [0, 1] }, { workType: "CAM" })]),
  ] }));
  assert.deepEqual(entries.map((entry) => [entry.title, entry.details]), [
    ["Completed 2 parts on OP1 · Haas CNC", ["Status: On Machine → Ready for QC"]],
    ["Claimed CAM for OP1", []],
    ["Claimed 2 parts on OP1 · Haas CNC", []],
  ]);
});

test("a QC write merges with its review, notes-only updates are labeled, and failures show rework", () => {
  const entries = buildRequirementHistory(payload({
    writes: [
      write("qc_review", "2026-09-21T10:00:05Z", [requirementRow({ qc_outcome: ["Not Inspected", "Failed"], status: ["Ready for QC", "Ready for Manufacturing"] }),
        op({ completed_quantity: [3, 1] })], { actor: "Alex A." }),
      write("qc_review", "2026-09-22T10:00:01Z", [requirementRow({ qc_notes: ["", "Bore checked"] })], { actor: "Alex A." }),
    ],
    reviews: [
      { id: 2, result: "passed", notes: "Bore checked", rejectedQuantity: null, at: "2026-09-22T10:00:00Z", reviewer: "Alex A.", retractedAt: null, retractedBy: null },
      { id: 1, result: "failed", notes: "Bore oversized", rejectedQuantity: 2, at: "2026-09-21T10:00:00Z", reviewer: "Alex A.", retractedAt: null, retractedBy: null },
      { id: 0, result: "passed", notes: "", rejectedQuantity: null, at: "2026-09-01T10:00:00Z", reviewer: "Legacy", retractedAt: "2026-09-02T10:00:00Z", retractedBy: "Alex A." },
    ],
  }));
  assert.deepEqual(entries.map((entry) => [entry.title, entry.tone, entry.details]), [
    ["Updated inspection notes", "note", ["“Bore checked”"]],
    ["QC failed · 2 parts rejected", "qc-fail", ["“Bore oversized”", "Sent 2 parts on OP1 · Haas CNC back for rework", "Status: Ready for QC → Ready for Manufacturing"]],
    ["QC passed", "qc-pass", ["Later undone by Alex A."]],
  ]);
});

test("corrections group under one entry with their reason, and sync retirements stand alone", () => {
  const entries = buildRequirementHistory(payload({
    writes: [write("engineering_override", "2026-09-23T09:00:00Z", [requirementRow({ required_quantity: [1, 2] })], {
      actor: "Alex A.",
      corrections: [
        { entity: "requirements", field: "required_quantity", action: "set", value: 2, syncedValue: 1, reason: "BOM missed the mirror" },
        { entity: "parts", field: "material", action: "cleared", value: "7075", syncedValue: "6061", reason: "BOM missed the mirror" },
      ],
    })],
    syncEvents: [{ id: 5, entity: "requirements", field: "required_quantity", action: "retired", value: 2, syncedValue: 2, at: "2026-09-24T09:00:00Z" }],
  }));
  assert.deepEqual(entries.map((entry) => [entry.title, entry.actor, entry.details]), [
    ["Onshape now matches the corrected Quantity (2); correction retired", "Onshape sync", []],
    ["Corrected Onshape data", "Alex A.", ["Quantity set to 2 (Onshape: 1)", "Material reverted to Onshape’s 6061", "Reason: BOM missed the mirror"]],
  ]);
});

test("locations, notes, and obsoletion get their own wording", () => {
  const entries = buildRequirementHistory(payload({ writes: [
    write("part_location", "2026-09-20T03:00:00Z", [requirementRow({ part_location: [null, "Shelf 2"] })]),
    write("requirement_note", "2026-09-20T02:00:00Z", [requirementRow({ production_notes: ["", "Deburr  the\nedges"] })]),
    write("requirement_obsoletion", "2026-09-20T01:00:00Z", [requirementRow({ obsolete: [false, true] })]),
  ] }));
  assert.deepEqual(entries.map((entry) => [entry.title, entry.tone]), [
    ["Moved to Shelf 2", "location"], ["Production notes: “Deburr the edges”", "note"], ["Marked obsolete", "status"],
  ]);
});
