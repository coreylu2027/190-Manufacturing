import assert from "node:assert/strict";
import test from "node:test";

import { mergeVisibleSelection, postBulk, settleConcurrently, settleSequentially, toBulkOutcomes } from "./bulk-selection.ts";

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

test("independent bulk tasks run up to the limit at once and keep input order", async () => {
  let active = 0;
  let maximumActive = 0;
  const failure = new Error("download failed");

  const results = await settleConcurrently([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 6 - item));
    active -= 1;
    if (item === 4) throw failure;
    return item * 10;
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(results, [
    { status: "fulfilled", value: 10 },
    { status: "fulfilled", value: 20 },
    { status: "fulfilled", value: 30 },
    { status: "rejected", reason: failure },
    { status: "fulfilled", value: 50 },
  ]);
});

test("bulk outcomes report each failure's message in request order", () => {
  assert.deepEqual(toBulkOutcomes([
    { status: "fulfilled", value: 1 },
    { status: "rejected", reason: new Error("Only 1 part(s) remain available") },
    { status: "rejected", reason: "not an error" },
  ], "Unable to update"), [
    { ok: true, value: 1 },
    { ok: false, error: "Only 1 part(s) remain available" },
    { ok: false, error: "Unable to update" },
  ]);
});

test("bulk requests are chunked and a failed request rejects only its own chunk", async (context) => {
  const bodies: unknown[] = [];
  context.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { ids: number[] };
    bodies.push(body);
    if (body.ids.includes(3)) return Response.json({ error: "The manufacturing database is busy." }, { status: 503 });
    return Response.json({ results: body.ids.map((id) => id === 2 ? { ok: false, error: "Already claimed" } : { ok: true, value: id * 10 }) });
  });
  const progress: number[] = [];

  const results = await postBulk<number, number>("/api/bulk", [1, 2, 3, 4, 5], {
    body: (ids) => ({ ids }),
    fallbackError: "Unable to update",
    chunkSize: 2,
    onProgress: (settled) => progress.push(settled),
  });

  assert.deepEqual(bodies, [{ ids: [1, 2] }, { ids: [3, 4] }, { ids: [5] }]);
  assert.deepEqual(progress, [2, 4, 5]);
  assert.deepEqual(results.map((result) => result.status === "fulfilled" ? result.value : (result.reason as Error).message), [
    10, "Already claimed", "The manufacturing database is busy.", "The manufacturing database is busy.", 50,
  ]);
});
