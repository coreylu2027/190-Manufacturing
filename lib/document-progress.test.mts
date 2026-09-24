import test from "node:test";
import assert from "node:assert/strict";

import { documentProgress, syncedFrom, type ProgressRequirement } from "./document-progress.ts";
import type { ProductionStatus } from "./production-status.ts";

const part = (status: ProductionStatus, options: Partial<ProgressRequirement> = {}): ProgressRequirement => ({
  assemblyNumber: "A-1", documentName: "A-26C-0004", syncedFromDocument: "A-26C-0004", status, obsolete: false, ...options,
});

test("imported subassembly parts count toward the document they were synced from", () => {
  const roller = { assemblyNumber: "A-2", documentName: "Configurable Roller", syncedFromDocument: "A-26C-0004" };
  assert.equal(syncedFrom(roller), "A-26C-0004");
  assert.equal(syncedFrom({ documentName: "A-26C-0009", syncedFromDocument: null }), "A-26C-0009");
  const [document] = documentProgress([part("Complete"), part("In Progress", roller)]);
  assert.deepEqual([document.document, document.assemblies, document.total, document.percentComplete], ["A-26C-0004", ["A-1", "A-2"], 2, 50]);
});

test("document progress sorts by name with unsynced last, and excludes obsolete and bought parts from completion", () => {
  const result = documentProgress([
    part("Complete", { syncedFromDocument: "A-26C-0010" }), part("Planned", { documentName: null, syncedFromDocument: null }),
    part("Complete"), part("Complete"), part("QC Pending"), part("Off the Shelf"), part("Planned", { obsolete: true }),
    part("Planned", { syncedFromDocument: "A-26C-0005", obsolete: true }),
  ]);
  assert.deepEqual(result.map((group) => group.document), ["A-26C-0004", "A-26C-0010", ""]);
  const [first] = result;
  assert.deepEqual([first.total, first.obsolete, first.made, first.percentComplete], [4, 1, { complete: 2, total: 3 }, 66]);
  assert.deepEqual([first.counts.Complete, first.counts["QC Pending"], first.counts["Off the Shelf"]], [2, 1, 1]);
  assert.equal(documentProgress([part("Off the Shelf")])[0].percentComplete, 100);
});
