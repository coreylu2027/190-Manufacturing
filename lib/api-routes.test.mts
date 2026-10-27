import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import * as bulkSelection from "./bulk-selection.ts";
import { HttpError } from "./http-error.ts";
import { isUserId, ManufacturingWriteError } from "./manufacturing/write-adapter.ts";
import * as profileName from "./profile-name.ts";
import * as qualityControl from "./quality-control.ts";
import { loadModule } from "./test-module-loader.mts";

const nextServer = { NextResponse: { json: (body: unknown, options?: { status: number }) => ({ body, status: options?.status ?? 200 }) } };

function route(path: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  return loadModule<Record<string, (...args: unknown[]) => Promise<{ status: number; body: Record<string, unknown> }>>>(
    new URL(path, import.meta.url), { "next/server": nextServer, ...dependencies }, { process, ...globals });
}

/** The real route helpers, signed in as whoever `getAppUser` returns. They share this realm's Error so stub errors keep their messages. */
function apiRoute(getAppUser: () => Promise<unknown>) {
  return route("./api-route.ts", { "@/lib/auth": { getAppUser }, "@/lib/http-error": { HttpError } }, { Error });
}

/** The real Slack helpers, collecting each event instead of posting it. */
function slack(events: Array<Record<string, unknown>>) {
  return route("./slack-notifications.ts", {
    "server-only": {},
    "next/server": { after: (task: () => unknown) => task() },
    "@/lib/slack-notifications-core": {
      postSlackManufacturingEvent: async (_url: string, event: Record<string, unknown>) => { events.push(event); return { status: "sent" }; },
    },
  }, { process: { env: { SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/x" } } });
}

/** Responses built inside a sandbox, as plain JSON for deep comparison. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const admin = { id: "admin", name: "Alex A.", approved: true, role: "admin" };

test("only approved admins can hide requirements through the API", async () => {
  let user: { id: string; name: string; approved: boolean; role: string } | null = null;
  let writes = 0;
  const api = route("../app/api/requirements/[id]/visibility/route.ts", {
    zod: { z },
    "@/lib/api-route": apiRoute(async () => user),
    "@/lib/manufacturing": { setRequirementHidden: async () => { writes++; return { hidden: true, visibilityVersion: 1 }; } },
  });
  const send = (body: unknown = { hidden: true, expectedVersion: 0 }, id = "20") => api.PUT(
    new Request("https://example.com/api/requirements/20/visibility", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
  assert.deepEqual(plain(await send()), { status: 401, body: { error: "Authentication required" } });
  user = { id: "admin", name: "Alex A.", approved: true, role: "machinist" };
  assert.deepEqual(plain(await send()), { status: 403, body: { error: "Administrator access required" } });
  user = { ...user, role: "admin", approved: false };
  assert.deepEqual(plain(await send()), { status: 403, body: { error: "Administrator access required" } });
  user = { ...user, approved: true };
  assert.equal((await send({ hidden: true })).status, 400);
  assert.equal((await send("{not json")).status, 400);
  assert.equal((await send(undefined, "NaN")).status, 400);
  assert.equal((await send(undefined, "0")).status, 400);
  assert.equal(writes, 0);
  assert.equal((await send()).status, 200);
  assert.equal(writes, 1);
});

test("route helpers keep the approval code and map only HTTP errors to their status", async () => {
  let user: unknown = { id: "pat", name: "Pat P.", approved: false, role: "machinist" };
  const helpers = apiRoute(async () => user) as unknown as {
    requireUser(options?: { admin?: boolean }): Promise<{ response?: { status: number; body: unknown } }>;
    parseId(raw: string): number | null;
    errorResponse(error: unknown, fallback: string): { status: number; body: unknown };
  };
  assert.deepEqual(plain((await helpers.requireUser()).response), { status: 403, body: { error: "Account approval required", code: "APPROVAL_REQUIRED" } });
  user = null;
  assert.deepEqual(plain((await helpers.requireUser({ admin: true })).response), { status: 401, body: { error: "Authentication required" } });
  assert.deepEqual(plain(["7", "0", "-3", "1.5", "", "9007199254740993"].map(helpers.parseId)), [7, null, null, null, null, null]);
  assert.deepEqual(plain(helpers.errorResponse(new HttpError("Gone", 410), "x")), { status: 410, body: { error: "Gone" } });
  assert.deepEqual(plain(helpers.errorResponse(new Error("Upstream"), "x")), { status: 502, body: { error: "Upstream" } });
  assert.deepEqual(plain(helpers.errorResponse("odd", "Fallback")), { status: 502, body: { error: "Fallback" } });
});

test("normal lists omit hidden work while admins can retrieve the production archive", async () => {
  let role = "machinist";
  const visible = { id: 1, hidden: false };
  const hidden = { id: 2, hidden: true };
  const dependencies = {
    "@/lib/api-route": apiRoute(async () => ({ approved: true, role })),
    "@/lib/manufacturing/cache": { getCurrentManufacturingSnapshot: async () => ({ version: "1", snapshot: { operations: [visible, hidden], jobs: [visible, hidden], cotsRequirements: [visible, hidden] } }) },
  };
  const operations = route("../app/api/operations/route.ts", dependencies);
  const finishing = route("../app/api/fabrication/route.ts", dependencies);
  assert.deepEqual((await operations.GET()).body.operations, [visible]);
  assert.deepEqual((await operations.GET()).body.cotsRequirements, [visible]);
  assert.deepEqual((await finishing.GET()).body.jobs, [visible]);
  role = "admin";
  assert.deepEqual((await operations.GET()).body.operations, [visible, hidden]);
  assert.deepEqual((await operations.GET()).body.cotsRequirements, [visible, hidden]);
  assert.deepEqual((await finishing.GET()).body.jobs, [visible]);
});

type Profile = { id: string; display_name: string; approved: boolean };

/** A Supabase client double covering the profile queries the account routes make. */
function profileClient(profiles: Profile[], options: { failUpdates?: boolean } = {}) {
  const writes: Array<{ kind: string; values: Record<string, unknown> }> = [];
  const client = {
    from: () => ({
      select: () => Object.assign(Promise.resolve({ data: profiles, error: null }), {
        eq: (_column: string, id: string) => ({
          maybeSingle: async () => ({ data: profiles.find((profile) => profile.id === id) ?? null, error: null }),
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          if (options.failUpdates) return { error: { message: "profile update failed" } };
          writes.push({ kind: "update", values: { ...values, id } });
          return { error: null };
        },
      }),
      upsert: async (values: Record<string, unknown>) => { writes.push({ kind: "upsert", values }); return { error: null }; },
    }),
  };
  return { client, writes };
}

type AuthModule = {
  getAppUser: () => Promise<{ name: string; approved: boolean }>;
  findShopNameOwner: (admin: unknown, name: string, exceptUserId: string) => Promise<string | null>;
  accountName: (user: unknown, profile: unknown, lastResort?: string) => string;
};

function loadAuth(currentUser: { id: string; email: string; user_metadata: Record<string, string> }, profiles: Profile[]) {
  const { client } = profileClient(profiles);
  const session = { ...client, auth: { getUser: async () => ({ data: { user: currentUser } }) } };
  return route("./auth.ts", {
    "server-only": {},
    "@/lib/supabase/admin": { createAdminClient: () => null },
    "@/lib/supabase/server": { createClient: async () => session },
  }) as unknown as AuthModule;
}

test("shop names come from the server-written profile, not user-editable auth metadata", async () => {
  const profiles = [{ id: "bob", display_name: "Bob B.", approved: true }, { id: "chris", display_name: "Chris C.", approved: true }];
  const spoofing = { id: "bob", email: "bob@example.com", user_metadata: { full_name: "Chris C." } };
  const user = await loadAuth(spoofing, profiles).getAppUser();
  assert.equal(user.name, "Bob B.");
  assert.equal(user.approved, true);
  // A blank profile name falls back to the email, never to metadata.
  assert.equal((await loadAuth(spoofing, [{ id: "bob", display_name: "  ", approved: true }]).getAppUser()).name, "bob");
  // Only an account with no profile yet is named from metadata.
  assert.equal((await loadAuth({ ...spoofing, id: "new" }, profiles).getAppUser()).name, "Chris C.");
});

test("shop name ownership is case-insensitive, counts every account, and ignores the account itself", async () => {
  const { client } = profileClient([
    { id: "bob", display_name: "Bob B.", approved: true },
    { id: "pat", display_name: " Pat P. ", approved: false },
  ]);
  const auth = loadAuth({ id: "x", email: "x@example.com", user_metadata: {} }, []);
  assert.equal(await auth.findShopNameOwner(client, "bob b.", "someone"), "bob");
  assert.equal(await auth.findShopNameOwner(client, "Bob B.", "bob"), null);
  assert.equal(await auth.findShopNameOwner(client, "Pat P.", "someone"), "pat");
});

test("renaming refuses taken names, moves work for approved accounts, and lets a pending duplicate rename away", async () => {
  let user: { id: string; name: string; approved: boolean; role: string } | null = null;
  let failUpdates = false;
  const renames: unknown[][] = [];
  const profiles: Profile[] = [{ id: "chris", display_name: "Chris C.", approved: true }, { id: "copy", display_name: "chris c.", approved: false }];
  const auth = loadAuth({ id: "x", email: "x@example.com", user_metadata: {} }, []);
  const ok = profileClient(profiles);
  const failing = profileClient(profiles, { failUpdates: true });
  const api = route("../app/api/account/route.ts", {
    "@/lib/api-route": apiRoute(async () => user),
    "@/lib/auth": { getAppUser: async () => user, findShopNameOwner: auth.findShopNameOwner },
    "@/lib/manufacturing": { renameMachinistAllocations: async (...args: unknown[]) => { renames.push(args); } },
    "@/lib/profile-name": profileName,
    "@/lib/supabase/admin": { createAdminClient: () => (failUpdates ? failing : ok).client },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { updateUser: async () => ({ error: null }) } }) },
  });
  const send = (firstName: string, lastInitial: string) => api.PATCH(new Request("https://example.com/api/account", {
    method: "PATCH", body: JSON.stringify({ firstName, lastInitial }),
  }));
  assert.equal((await send("Sam", "S")).status, 401);

  user = { id: "bob", name: "Bob B.", approved: true, role: "machinist" };
  const taken = await send("chris", "c");
  assert.equal(taken.status, 409);
  assert.match(String(taken.body.error), /already uses the shop name "Chris C\."/);
  assert.equal(renames.length + ok.writes.length, 0);

  // Unapproved accounts, pending or revoked, cannot rename unless their name blocks approval.
  user = { id: "pat", name: "Pat P.", approved: false, role: "machinist" };
  const pending = await send("Patricia", "P");
  assert.equal(pending.status, 403);
  assert.equal(pending.body.code, "APPROVAL_REQUIRED");
  assert.equal(renames.length + ok.writes.length, 0);

  // A pending duplicate moves off the name; the other account keeps it and its work, so nothing is renamed.
  user = { id: "copy", name: "chris c.", approved: false, role: "machinist" };
  assert.equal((await send("Christopher", "C")).status, 200);
  assert.equal(renames.length, 0);
  assert.deepEqual(ok.writes.map((write) => [write.values.id, write.values.display_name]), [["copy", "Christopher C."]]);

  user = { id: "bob", name: "Bob B.", approved: true, role: "machinist" };
  assert.equal((await send("Robert", "B")).status, 200);
  assert.deepEqual(renames, [["bob", "Bob B.", "Robert B."]]);

  failUpdates = true;
  const failed = await send("Bobby", "B");
  assert.equal(failed.status, 502);
  assert.match(String(failed.body.error), /profile update failed/);
});

test("approval keeps the profile shop name and refuses a duplicate of any account", async () => {
  const profiles: Profile[] = [
    { id: "chris", display_name: "Chris C.", approved: false },
    { id: "pat", display_name: "Pat P.", approved: false },
    { id: "copy", display_name: "chris c.", approved: false },
  ];
  const { client, writes } = profileClient(profiles);
  const auth = loadAuth({ id: "x", email: "x@example.com", user_metadata: {} }, []);
  const api = route("../app/api/admin/users/[id]/route.ts", {
    zod: { z },
    "@/lib/api-route": apiRoute(async () => admin),
    "@/lib/auth": { accountName: auth.accountName, findShopNameOwner: auth.findShopNameOwner },
    "@/lib/types": { USER_ROLES: ["machinist", "admin"] },
    "@/lib/supabase/admin": {
      createAdminClient: () => ({
        ...client,
        // Metadata says otherwise, but the profile name is the one that counts.
        auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id, email: `${id}@example.com`, user_metadata: { full_name: "Chris C." } } }, error: null }) } },
      }),
    },
  });
  const approve = (id: string) => api.PATCH(
    new Request(`https://example.com/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ approved: true, role: "machinist" }) }),
    { params: Promise.resolve({ id }) },
  );
  // A revoked or pending holder of the name still blocks the duplicate.
  const duplicate = await approve("copy");
  assert.equal(duplicate.status, 409);
  assert.match(String(duplicate.body.error), /Pending page/);
  assert.equal(writes.length, 0);
  assert.equal((await approve("pat")).status, 200);
  assert.equal(writes[0].values.display_name, "Pat P.");
});

test("QC routes forward the adapter's post-QC readiness instead of guessing from status", async () => {
  const events: Array<Record<string, unknown>> = [];
  const api = route("../app/api/admin/qc/[id]/route.ts", {
    zod: { z },
    "@/lib/api-route": apiRoute(async () => admin),
    "@/lib/manufacturing": {
      recordQualityReview: async (_id: number, result: string) => ({
        requirementId: 20, result, rejectedQuantity: result === "failed" ? 2 : null,
        notificationContext: { requirementId: 20, previousRequirementStatus: "Ready for QC", requirementStatus: "Ready for Manufacturing", postQcWorkReady: result === "passed" },
      }),
    },
    "@/lib/slack-notifications": slack(events),
    "@/lib/storage-locations": { storageLocationSchema: z.string() },
  });
  const review = (body: unknown) => api.PATCH(
    new Request("https://example.com/api/admin/qc/20", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ id: "20" }) },
  );
  // A malformed body is a bad request, not an unhandled server error.
  assert.equal((await review("{")).status, 400);
  assert.equal((await review({ result: "failed", notes: "Bad bore" })).status, 200);
  assert.equal(events[0].postQcWorkReady, false);
  assert.equal((await review({ result: "passed" })).status, 200);
  assert.equal(events[1].postQcWorkReady, true);
});

test("Force QC forwards post-QC readiness and the rejected quantity to Slack", async () => {
  const events: Array<Record<string, unknown>> = [];
  const api = route("../app/api/admin/qc/[id]/force/route.ts", {
    zod: { z },
    "@/lib/api-route": apiRoute(async () => admin),
    "@/lib/manufacturing": {
      previewForceQuality: async () => ({}),
      forceQualityReview: async (_id: number, _notes: string, _token: string, _actor: unknown, result: string) => ({
        requirementId: 20, result, rejectedQuantity: result === "failed" ? 2 : null, finishingCompleted: false,
        notificationContext: { requirementId: 20, previousRequirementStatus: "Ready for Manufacturing", requirementStatus: "Ready for Manufacturing", postQcWorkReady: result === "passed" },
      }),
    },
    "@/lib/slack-notifications": slack(events),
  });
  const force = (body: unknown) => api.POST(
    new Request("https://example.com/api/admin/qc/20/force", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "20" }) },
  );
  assert.equal((await force({ notes: "Forced", token: "t" })).status, 200);
  assert.equal(events[0].postQcWorkReady, true);
  assert.equal(events[0].rejectedQuantity, null);
  assert.equal((await force({ notes: "Bad", token: "t", result: "failed" })).status, 200);
  assert.equal(events[1].postQcWorkReady, false);
  assert.equal(events[1].rejectedQuantity, 2);
});

test("bulk routes keep their single routes' access rules and reject duplicate or oversized batches", async () => {
  let user: unknown = null;
  let writes = 0;
  const write = async (...args: unknown[]) => { writes++; return (args.find(Array.isArray) as unknown[]).map(() => ({ status: "fulfilled", value: { notificationContext: {} } })); };
  const dependencies = {
    zod: { z },
    "@/lib/api-route": apiRoute(async () => user),
    "@/lib/bulk-selection": bulkSelection,
    "@/lib/manufacturing": { applyQuantityActions: write, applyFabricationActions: write, updatePartLocations: write, passQualityReviews: write, forceQualityReviews: write },
    "@/lib/manufacturing/write-adapter": { ManufacturingWriteError },
    "@/lib/profile-name": profileName,
    "@/lib/quality-control": qualityControl,
    "@/lib/slack-notifications": slack([]),
    "@/lib/storage-locations": { storageLocationSchema: z.string() },
  };
  const many = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
  const routes = [
    { path: "../app/api/operations/bulk/route.ts", admin: false, body: (ids: number[]) => ({ action: "claim", items: ids.map((id) => ({ id, quantity: 1 })) }) },
    { path: "../app/api/fabrication/bulk/route.ts", admin: false, body: (ids: number[]) => ({ action: "claim", ids }) },
    { path: "../app/api/requirements/bulk/location/route.ts", admin: false, body: (ids: number[]) => ({ requirementIds: ids, location: null }) },
    { path: "../app/api/admin/qc/bulk/route.ts", admin: true, body: (ids: number[]) => ({ reviews: ids.map((requirementId) => ({ requirementId })) }) },
    { path: "../app/api/admin/qc/bulk/force/route.ts", admin: true, body: (ids: number[]) => ({ requirementIds: ids, notes: "", result: "passed" }) },
  ];
  for (const { path, admin, body } of routes) {
    const api = route(path, dependencies);
    const post = (payload: unknown) => api.POST(new Request("https://example.com/", { method: "POST", body: typeof payload === "string" ? payload : JSON.stringify(payload) }));
    user = null;
    assert.equal((await post(body([1]))).status, 401, path);
    user = { id: "pat", name: "Pat P.", approved: true, role: "machinist" };
    assert.equal((await post(body([1]))).status, admin ? 403 : 200, path);
    user = { ...user as object, role: "admin" };
    writes = 0;
    assert.equal((await post("{")).status, 400, path);
    assert.equal((await post(body([1, 1]))).status, 400, path);
    assert.equal((await post(body(many(bulkSelection.BULK_REQUEST_SIZE + 1)))).status, 400, path);
    assert.equal(writes, 0, path);
    assert.equal((await post(body(many(bulkSelection.BULK_REQUEST_SIZE)))).status, 200, path);
  }
});

test("bulk routes report each outcome in order and announce only committed work with the adapter's flags", async () => {
  const events: Array<Record<string, unknown>> = [];
  const api = route("../app/api/operations/bulk/route.ts", {
    zod: { z },
    "@/lib/api-route": apiRoute(async () => ({ id: "alex", name: "Alex A.", approved: true, role: "machinist" })),
    "@/lib/bulk-selection": bulkSelection,
    "@/lib/manufacturing": {
      applyQuantityActions: async () => [
        { status: "fulfilled", value: { id: 10, status: "Complete", notificationContext: {
          requirementId: 20, partNumber: "P-1", partName: "Fixture", assemblyNumber: "A-1", operationNumber: "OP1", workType: "Manufacturing", machine: "Mill",
          previousRequirementStatus: "Ready for Manufacturing", requirementStatus: "Ready for QC", postQcWorkReady: true,
        } } },
        { status: "rejected", reason: new ManufacturingWriteError("Only 1 part(s) remain available", 409) },
      ],
    },
    "@/lib/profile-name": profileName,
    "@/lib/slack-notifications": slack(events),
    "@/lib/storage-locations": { storageLocationSchema: z.string() },
  });
  const response = await api.POST(new Request("https://example.com/", { method: "POST",
    body: JSON.stringify({ action: "complete", items: [{ id: 10, quantity: 2 }, { id: 11, quantity: 1 }] }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(plain(response.body.results), [
    { ok: true, value: { id: 10, status: "Complete" } },
    { ok: false, error: "Only 1 part(s) remain available" },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "operation_completed");
  assert.equal(events[0].quantity, 2);
  assert.equal(events[0].becameReadyForQc, true);
  assert.equal(events[0].postQcWorkReady, true);
});

test("a committed steal still succeeds when notifying a displaced claimant fails", async () => {
  const events: Array<Record<string, unknown>> = [];
  const errors: unknown[][] = [];
  const displaced = [
    { userId: "00000000-0000-4000-8000-000000000001", name: "Bob B.", quantity: 1 },
    { userId: "00000000-0000-4000-8000-000000000002", name: "Cam C.", quantity: 1 },
  ];
  const api = route("../app/api/operations/[id]/route.ts", {
    zod: { z },
    "@/lib/api-route": apiRoute(async () => ({ id: "alex", name: "Alex A.", approved: true, role: "machinist" })),
    "@/lib/manufacturing": {
      stealOperationClaim: async () => ({
        updated: { id: 10, status: "In Progress" },
        displaced,
        context: { operationId: 10, requirementId: 20, partNumber: "P-1", partName: "Fixture", assemblyNumber: "A-1", operationNumber: "OP1", workType: "Manufacturing", machine: "Mill", quantity: 2 },
      }),
    },
    "@/lib/notifications": {
      createNotification: async ({ recipientId }: { recipientId: string }) => {
        if (recipientId === displaced[0].userId) throw new Error("notification store unavailable");
        return { stored: true, email: "sent" };
      },
    },
    "@/lib/profile-name": profileName,
    "@/lib/slack-notifications": slack(events),
    "@/lib/types": { OPERATION_STATUSES: ["Planned", "Ready", "In Progress", "Blocked", "Complete"] },
    "@/lib/manufacturing/write-adapter": { isUserId },
    "@/lib/storage-locations": { storageLocationSchema: z.string() },
  }, { console: { error: (...args: unknown[]) => errors.push(args) } });
  const response = await api.PATCH(
    new Request("https://example.com/api/operations/10", { method: "PATCH", body: JSON.stringify({ action: "steal", confirmed: true }) }),
    { params: Promise.resolve({ id: "10" }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(plain(response.body.notificationDelivery),
    { alertsStored: 1, emailsSent: 1, emailsFailed: 1, emailsSkipped: 0, unmappedRecipients: 0 });
  assert.equal(events.length, 1);
  assert.equal(errors.length, 1);
});

test("operation and finishing file routes keep their messages and pass stored-file errors through", async () => {
  class FileError extends HttpError {}
  type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<unknown>;
  const stored: unknown[][] = [];
  let failure: Error | null = null;
  const routes = route("./manufacturing/file-routes.ts", {
    "server-only": {},
    "@/lib/api-route": apiRoute(async () => ({ id: "alex", name: "Alex A.", approved: true, role: "machinist" })),
    "./cache": {
      getCurrentManufacturingSnapshot: async () => ({ snapshot: {
        operations: [{ id: 1, requirementId: 20, partNumber: "P-1" }, { id: 2, requirementId: null, partNumber: "P-2" }],
        jobs: [{ id: 3, requirementId: 30, partNumber: "P-3" }],
      } }),
    },
    "./files": {
      ManufacturingFileError: FileError,
      storedManufacturingFileResponse: async (...args: unknown[]) => { if (failure) throw failure; stored.push(args); return { status: 200 }; },
      storedManufacturingPreviewResponse: async (requirementId: number) => { if (failure) throw failure; stored.push([requirementId]); return { status: 200 }; },
    },
  }, { Error }) as unknown as { workItemFileRoute(source: string): Handler; workItemPreviewRoute(source: string): Handler };
  const request = new Request("https://example.com/");
  const file = async (source: string, id: string, kind = "drawing-pdf") =>
    plain(await routes.workItemFileRoute(source)(request, { params: Promise.resolve({ id, kind }) }));
  const preview = async (source: string, id: string) =>
    plain(await routes.workItemPreviewRoute(source)(request, { params: Promise.resolve({ id }) }));

  assert.deepEqual(await file("operations", "x"), { status: 400, body: { error: "Invalid operation ID" } });
  assert.deepEqual(await preview("jobs", "0"), { status: 400, body: { error: "Invalid finishing job ID" } });
  assert.deepEqual(await file("jobs", "3", "zip"), { status: 400, body: { error: "Invalid file type" } });
  assert.deepEqual(await file("operations", "9"), { status: 404, body: { error: "Operation not found" } });
  assert.deepEqual(await preview("jobs", "9"), { status: 404, body: { error: "Finishing job not found" } });
  assert.deepEqual(await file("operations", "2"), { status: 404, body: { error: "File not found" } });
  assert.deepEqual(await preview("operations", "2"), { status: 404, body: { error: "Preview not found" } });
  assert.deepEqual(await file("jobs", "3", "step"), { status: 200 });
  assert.deepEqual(await preview("operations", "1"), { status: 200 });
  assert.deepEqual(stored, [[30, "step", "P-3.step"], [20]]);
  // The preview pane shows a 404 as "not available yet", so a stored-file error must keep its status.
  failure = new FileError("A 3D preview has not been generated for this part", 404);
  assert.deepEqual(await preview("jobs", "3"), { status: 404, body: { error: "A 3D preview has not been generated for this part" } });
  failure = new Error("Storage offline");
  assert.deepEqual(await file("operations", "1"), { status: 502, body: { error: "Storage offline" } });
});
