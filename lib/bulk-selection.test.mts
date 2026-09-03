import assert from "node:assert/strict";
import test from "node:test";

import { mergeVisibleSelection } from "./bulk-selection.ts";

test("bulk selection keeps rows hidden by search or filters", () => {
  assert.deepEqual(mergeVisibleSelection([1, 2], [2, 3], [2]), [1, 2]);
});

test("bulk selection applies checkbox changes to visible rows", () => {
  assert.deepEqual(mergeVisibleSelection([1, 2], [2, 3], [3]), [1, 3]);
});
