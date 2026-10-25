import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import * as profileName from "./profile-name.ts";
import { loadModule } from "./test-module-loader.mts";

const nextServer = { NextResponse: { json: (body: unknown, options?: { status: number }) => ({ body, status: options?.status ?? 200 }) } };

function route(path: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  return loadModule<Record<string, (...args: unknown[]) => Promise<{ status: number; body: Record<string, unknown> }>>>(
    new URL(path, import.meta.url), { "next/server": nextServer, ...dependencies }, { process, ...globals });
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
};

function loadAuth(currentUser: { id: string; email: string; user_metadata: Record<string, string> }, profiles: Profile[]) {
  const { client } = profileClient(profiles);
  return route("./auth.ts", {
    "server-only": {},
    "@/lib/supabase/admin": { createAdminClient: () => null },
    "@/lib/supabase/server": { createClient: async () => client, getCurrentUser: async () => currentUser },
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
    "@/lib/auth": { getAppUser: async () => user, findShopNameOwner: auth.findShopNameOwner },
    "@/lib/manufacturing": { renameMachinistAllocations: async (...args: unknown[]) => { renames.push(args); } },
    "@/lib/manufacturing/write-adapter": { ManufacturingWriteError: class extends Error {} },
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
    "@/lib/auth": {
      APP_ROLES: ["machinist", "admin"],
      findShopNameOwner: auth.findShopNameOwner,
      getAdminActor: async () => ({ id: "admin", name: "Alex A.", approved: true, role: "admin" }),
    },
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
    "@/lib/auth": { getAdminActor: async () => ({ id: "admin", name: "Alex A.", approved: true, role: "admin" }) },
    "@/lib/manufacturing": {
      recordQualityReview: async (_id: number, result: string) => ({
        requirementId: 20, result, rejectedQuantity: result === "failed" ? 2 : null,
        notificationContext: { requirementId: 20, previousRequirementStatus: "Ready for QC", requirementStatus: "Ready for Manufacturing", postQcWorkReady: result === "passed" },
      }),
    },
    "@/lib/manufacturing/write-adapter": { ManufacturingWriteError: class extends Error {} },
    "@/lib/slack-notifications": { scheduleSlackManufacturingEvent: (event: Record<string, unknown>) => events.push(event) },
    "@/lib/storage-locations": { storageLocationSchema: z.string() },
  });
  const review = (body: unknown) => api.PATCH(
    new Request("https://example.com/api/admin/qc/20", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "20" }) },
  );
  assert.equal((await review({ result: "failed", notes: "Bad bore" })).status, 200);
  assert.equal(events[0].postQcWorkReady, false);
  assert.equal((await review({ result: "passed" })).status, 200);
  assert.equal(events[1].postQcWorkReady, true);
});

test("Force QC forwards post-QC readiness and the rejected quantity to Slack", async () => {
  const events: Array<Record<string, unknown>> = [];
  const api = route("../app/api/admin/qc/[id]/force/route.ts", {
    zod: { z },
    "@/lib/auth": { getAdminActor: async () => ({ id: "admin", name: "Alex A.", approved: true, role: "admin" }) },
    "@/lib/manufacturing": {
      previewForceQuality: async () => ({}),
      forceQualityReview: async (_id: number, _notes: string, _token: string, _actor: unknown, result: string) => ({
        requirementId: 20, result, rejectedQuantity: result === "failed" ? 2 : null, finishingCompleted: false,
        notificationContext: { requirementId: 20, previousRequirementStatus: "Ready for Manufacturing", requirementStatus: "Ready for Manufacturing", postQcWorkReady: result === "passed" },
      }),
    },
    "@/lib/manufacturing/write-adapter": { ManufacturingWriteError: class extends Error {} },
    "@/lib/slack-notifications": { scheduleSlackManufacturingEvent: (event: Record<string, unknown>) => events.push(event) },
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

test("a committed steal still succeeds when notifying a displaced claimant fails", async () => {
  const events: Array<Record<string, unknown>> = [];
  const errors: unknown[][] = [];
  const displaced = [
    { userId: "00000000-0000-4000-8000-000000000001", name: "Bob B.", quantity: 1 },
    { userId: "00000000-0000-4000-8000-000000000002", name: "Cam C.", quantity: 1 },
  ];
  const api = route("../app/api/operations/[id]/route.ts", {
    zod: { z },
    "@/lib/auth": { getAppUser: async () => ({ id: "alex", name: "Alex A.", approved: true, role: "machinist" }) },
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
    "@/lib/slack-notifications": { scheduleSlackManufacturingEvent: (event: Record<string, unknown>) => events.push(event) },
    "@/lib/types": { OPERATION_STATUSES: ["Planned", "Ready", "In Progress", "Blocked", "Complete"] },
    "@/lib/manufacturing/write-adapter": { ManufacturingWriteError: class extends Error {} },
    "@/lib/storage-locations": { storageLocationSchema: z.string() },
  }, { console: { error: (...args: unknown[]) => errors.push(args) } });
  const response = await api.PATCH(
    new Request("https://example.com/api/operations/10", { method: "PATCH", body: JSON.stringify({ action: "steal", confirmed: true }) }),
    { params: Promise.resolve({ id: "10" }) },
  );
  assert.equal(response.status, 200);
  // The body was built inside the sandbox, so compare its plain JSON shape.
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.notificationDelivery)),
    { alertsStored: 1, emailsSent: 1, emailsFailed: 1, emailsSkipped: 0, unmappedRecipients: 0 });
  assert.equal(events.length, 1);
  assert.equal(errors.length, 1);
});
