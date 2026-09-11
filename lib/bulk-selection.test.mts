import assert from "node:assert/strict";
import test from "node:test";

import { mergeVisibleSelection, settleSequentially } from "./bulk-selection.ts";

test("bulk selection keeps rows hidden by search or filters", () => {
  assert.deepEqual(mergeVisibleSelection([1, 2], [2, 3], [2]), [1, 2]);
});

test("bulk selection applies checkbox changes to visible rows", () => {
  assert.deepEqual(mergeVisibleSelection([1, 2], [2, 3], [3]), [1, 3]);
});

test("bulk mutations run sequentially", async () => {
  let active = 0;
  let maximumActive = 0;
  const completed: number[] = [];

  const results = await settleSequentially([1, 2, 3], async (item) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    completed.push(item);
    active -= 1;
    return item * 2;
  });

  assert.equal(maximumActive, 1);
  assert.deepEqual(completed, [1, 2, 3]);
  assert.deepEqual(results, [
    { status: "fulfilled", value: 2 },
    { status: "fulfilled", value: 4 },
    { status: "fulfilled", value: 6 },
  ]);
});

test("bulk mutations continue after an individual failure", async () => {
  const attempted: number[] = [];
  const failure = new Error("claim failed");

  const results = await settleSequentially([1, 2, 3], async (item) => {
    attempted.push(item);
    if (item === 2) throw failure;
    return item;
  });

  assert.deepEqual(attempted, [1, 2, 3]);
  assert.deepEqual(results, [
    { status: "fulfilled", value: 1 },
    { status: "rejected", reason: failure },
    { status: "fulfilled", value: 3 },
  ]);
});
