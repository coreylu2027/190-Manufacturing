import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

function route(path: string, dependencies: Record<string, unknown>) {
  const exports: Record<string, (...args: unknown[]) => Promise<{ status: number; body: Record<string, unknown> }>> = {};
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules = {
    "next/server": { NextResponse: { json: (body: unknown, options?: { status: number }) => ({ body, status: options?.status ?? 200 }) } },
    ...dependencies,
  };
  runInNewContext(source, { exports, require: (name: string) => {
    assert.ok(name in modules, `Unexpected import ${name}`);
    return modules[name as keyof typeof modules];
  } });
  return exports;
}

test("only approved admins can hide requirements through the API", async () => {
  let user: { id: string; name: string; approved: boolean; role: string } | null = null;
  let writes = 0;
  class WriteError extends Error { status = 409; }
  const api = route("../app/api/requirements/[id]/visibility/route.ts", {
    zod: { z },
    "@/lib/auth": { getAppUser: async () => user },
    "@/lib/manufacturing": { setRequirementHidden: async () => { writes++; return { hidden: true, visibilityVersion: 1 }; } },
    "@/lib/manufacturing/write-adapter": { ManufacturingWriteError: WriteError },
  });
  const send = (body: unknown = { hidden: true, expectedVersion: 0 }, id = "20") => api.PUT(
    new Request("https://example.com/api/requirements/20/visibility", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal((await send()).status, 401);
  user = { id: "admin", name: "Alex A.", approved: true, role: "machinist" };
  assert.equal((await send()).status, 403);
  user = { ...user, role: "admin", approved: false };
  assert.equal((await send()).status, 403);
  user = { ...user, approved: true };
  assert.equal((await send({ hidden: true })).status, 400);
  assert.equal((await send(undefined, "NaN")).status, 400);
  assert.equal(writes, 0);
  assert.equal((await send()).status, 200);
  assert.equal(writes, 1);
});

test("normal lists omit hidden work while admins can retrieve the production archive", async () => {
  let role = "machinist";
  const visible = { id: 1, hidden: false };
  const hidden = { id: 2, hidden: true };
  const dependencies = {
    "@/lib/auth": { getAppUser: async () => ({ approved: true, role }) },
    "@/lib/manufacturing/cache": { getCurrentManufacturingSnapshot: async () => ({ version: "1", snapshot: { operations: [visible, hidden], jobs: [visible, hidden] } }) },
  };
  const operations = route("../app/api/operations/route.ts", dependencies);
  const finishing = route("../app/api/fabrication/route.ts", dependencies);
  assert.deepEqual((await operations.GET()).body.operations, [visible]);
  assert.deepEqual((await finishing.GET()).body.jobs, [visible]);
  role = "admin";
  assert.deepEqual((await operations.GET()).body.operations, [visible, hidden]);
  assert.deepEqual((await finishing.GET()).body.jobs, [visible]);
});
