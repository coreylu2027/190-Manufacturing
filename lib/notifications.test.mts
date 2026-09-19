import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { timingSafeEqual } from "node:crypto";
import ts from "typescript";

function load(path: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const exports: Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>> = {};
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, require: (name: string) => {
    assert.ok(name in dependencies, `Unexpected import ${name}`);
    return dependencies[name];
  }, AbortSignal, Buffer, Date, ...globals });
  return exports;
}

test("stored notifications reuse the email framework, escaping and idempotency key", async () => {
  const notification = { id: "alert-1", recipient_id: "user-1", title: "Stop work", message: "Plate <B>", data: {}, email_status: "pending", created_at: new Date().toISOString() };
  const updates: object[] = [];
  const sent: Array<{ headers: Record<string, string>; body: string }> = [];
  let failDelivery = false;
  const client = { from: (table: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "profiles" ? { email: "worker@example.com" } : notification }) }) }),
    update: (value: object) => ({ eq: () => {
      let excludeSent = false;
      const query = {
        neq: () => { excludeSent = true; return query; },
        then: (resolve: (result: object) => void) => {
          if (!excludeSent || notification.email_status !== "sent") {
            updates.push(value); Object.assign(notification, value);
          }
          resolve({});
        },
      };
      return query;
    } }),
  }) };
  const env = { RESEND_API_KEY: "test", NOTIFICATION_EMAIL_FROM: "shop@example.com" };
  const api = load("./notifications.ts", { "server-only": {}, "@/lib/supabase/admin": { createAdminClient: () => client } }, {
    process: { env }, fetch: async (_url: string, options: typeof sent[number]) => {
      sent.push(options); return { ok: !failDelivery, status: failDelivery ? 503 : 200, json: async () => failDelivery ? { message: "Unavailable" } : { id: "email-1" } };
    },
  });
  assert.equal((await api.deliverStoredNotificationEmail("alert-1")).email, "sent");
  assert.equal(sent[0].headers["Idempotency-Key"], "notification-alert-1");
  assert.match(JSON.parse(sent[0].body).html, /Plate &lt;B&gt;/);
  assert.deepEqual(JSON.parse(sent[0].body).to, ["worker@example.com"]);
  assert.equal((await api.deliverStoredNotificationEmail("alert-1")).email, "sent");
  assert.equal(sent.length, 1, "webhook replay after success must not send again");
  notification.email_status = "pending";
  env.RESEND_API_KEY = "";
  assert.equal((await api.deliverStoredNotificationEmail("alert-1")).email, "failed");
  assert.equal(notification.email_status, "pending", "missing config must preserve queued delivery");
  env.RESEND_API_KEY = "test";
  notification.created_at = "2020-01-01T00:00:00Z";
  assert.match(String((await api.deliverStoredNotificationEmail("alert-1")).error), /manual review/);
  assert.equal(sent.length, 1);
  assert.equal(updates.length, 1);
  notification.created_at = new Date().toISOString();
  failDelivery = true;
  assert.equal((await api.deliverStoredNotificationEmail("alert-1")).email, "failed");
  assert.equal(notification.email_status, "failed");
  failDelivery = false;
  assert.equal((await api.deliverStoredNotificationEmail("alert-1")).email, "sent");
  assert.equal(sent[1].headers["Idempotency-Key"], sent[2].headers["Idempotency-Key"]);
});

test("email webhook authenticates and only passes a notification ID to the sender", async () => {
  const ids: string[] = [];
  const api = load("../app/api/notifications/deliver/route.ts", {
    "node:crypto": { timingSafeEqual },
    "next/server": { NextResponse: { json: (body: unknown, options?: { status: number }) => ({ body, status: options?.status ?? 200 }) } },
    "@/lib/notifications": { deliverStoredNotificationEmail: async (id: string) => { ids.push(id); return { stored: true, email: "sent" }; } },
  }, { process: { env: { NOTIFICATION_WEBHOOK_SECRET: "test-secret" } } });
  const id = "00000000-0000-4000-8000-000000000190";
  const event = { type: "INSERT", schema: "public", table: "notifications", record: { id, recipient_id: "untrusted" } };
  const request = (auth: string, body: unknown = event) => new Request("https://example.com/api/notifications/deliver", {
    method: "POST", headers: { authorization: auth }, body: JSON.stringify(body),
  });
  assert.equal((await api.POST(request("Bearer wrong"))).status, 401);
  assert.equal((await api.POST(request("Bearer test-secret", { ...event, table: "profiles" }))).status, 400);
  assert.equal((await api.POST(request("Bearer test-secret"))).status, 200);
  assert.deepEqual(ids, [id]);
});
