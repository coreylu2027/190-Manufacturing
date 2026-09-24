import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSlackManufacturingEvent,
  postSlackManufacturingEvent,
  type SlackManufacturingEvent,
} from "./slack-notifications-core.ts";

const operationEvent: SlackManufacturingEvent = {
  type: "operation_completed",
  actorName: "Alex A.",
  requirementId: 20,
  partNumber: "P-1",
  partName: "Fixture <plate>",
  assemblyNumber: "A-1",
  operationNumber: "OP1",
  workType: "Manufacturing",
  machine: "Mill & Lathe",
  quantity: 2,
  becameReadyForQc: true,
};

test("obsoletion and restoration alerts identify the requirement and give safe work guidance", () => {
  const base = { actorName: "Alex <A>", requirementId: 20, partNumber: "P-1", partName: "Fixture <plate>", assemblyNumber: "A-1", revision: "B&2", location: "On Robot" };
  const obsolete = formatSlackManufacturingEvent({ ...base, type: "requirement_obsoleted" });
  assert.match(obsolete.text, /Do not manufacture or install/);
  const blocks = JSON.stringify(obsolete.blocks);
  for (const pattern of [/Alex &lt;A&gt;/, /Fixture &lt;plate&gt;/, /Assembly A-1/, /Requirement #20/, /Revision B&amp;2/, /currently recorded as On Robot/]) assert.match(blocks, pattern);
  const stored = formatSlackManufacturingEvent({ ...base, type: "requirement_obsoleted", location: null });
  assert.doesNotMatch(JSON.stringify(stored), /currently recorded as On Robot/);
  const restored = formatSlackManufacturingEvent({ ...base, type: "requirement_restored" });
  assert.match(restored.text, /restored from obsolete/);
  assert.match(JSON.stringify(restored.blocks), /Existing workflow, QC, and routing requirements still apply/);
  assert.doesNotMatch(JSON.stringify(restored.blocks), /Do not manufacture or install/);
});

test("operation notifications combine completion and the Ready for QC transition", () => {
  const payload = formatSlackManufacturingEvent(operationEvent);
  assert.match(payload.text, /Ready for QC/);
  assert.match(JSON.stringify(payload.blocks), /marked complete 2 parts/);
  assert.match(JSON.stringify(payload.blocks), /now ready for QC/);
  assert.match(JSON.stringify(payload.blocks), /Fixture &lt;plate&gt;/);
  assert.match(JSON.stringify(payload.blocks), /Mill &amp; Lathe/);
});

test("QC notifications include the result, reviewer, notes, and storage location", () => {
  const payload = formatSlackManufacturingEvent({
    type: "qc_reviewed",
    actorName: "Corey L.",
    requirementId: 20,
    partNumber: "P-1",
    partName: "Fixture",
    assemblyNumber: "A-1",
    result: "failed",
    notes: "Hole is out of tolerance",
    rejectedQuantity: 2,
  });
  assert.match(payload.text, /QC failed/);
  assert.match(JSON.stringify(payload.blocks), /Corey L\./);
  assert.match(JSON.stringify(payload.blocks), /Hole is out of tolerance/);
  assert.match(JSON.stringify(payload.blocks), /Rejected.*2 parts/);
});

test("high-value workflow events have distinct, useful Slack messages", () => {
  const base = {
    actorName: "Corey L.",
    requirementId: 20,
    partNumber: "P-1",
    partName: "Fixture",
    assemblyNumber: "A-1",
  };
  const events: Array<[SlackManufacturingEvent, RegExp]> = [
    [{ ...base, type: "operation_released", operationNumber: "OP1", workType: "Manufacturing", machine: "Mill", quantity: 1 }, /Claim released/],
    [{ ...base, type: "operation_reopened", operationNumber: "OP1", workType: "Manufacturing", machine: "Mill", quantity: 1 }, /Work reopened/],
    [{ ...base, type: "finishing_released", color: "Black", quantity: 2 }, /Finishing claim released/],
    [{ ...base, type: "finishing_reopened", color: "Black", quantity: 2 }, /Finishing reopened/],
    [{ ...base, type: "finishing_completed", color: "Black", quantity: 2, postQcWorkReady: true }, /Post-QC manufacturing work is now ready/],
    [{ ...base, type: "operation_completed", operationNumber: "OP2", workType: "Manufacturing", machine: "Mill", quantity: 2, becameComplete: true }, /All work for this part is complete/],
    [{ ...base, type: "qc_reopened" }, /QC approval undone/],
    [{ ...base, type: "location_changed", previousLocation: "Kwolek 2-8", location: "On Robot" }, /moved onto robot/],
    [{ ...base, type: "cam_handoff_edited", operationNumber: "OP2", machine: "Haas", changedFields: ["program path", "notes"] }, /CAM handoff edited/],
    [{ ...base, type: "admin_override", operationNumber: "OP1", workType: "Manufacturing", machine: "Mill", changes: ["status Ready → Blocked"] }, /Administrator override/],
    [{ ...base, type: "qc_reviewed", result: "passed", notes: "", becameReadyForFinishing: true }, /ready for finishing/],
  ];

  for (const [event, expected] of events) {
    const payload = formatSlackManufacturingEvent(event);
    assert.match(`${payload.text}\n${JSON.stringify(payload.blocks)}`, expected);
  }
});

test("webhook delivery posts JSON and retries one Slack rate limit", async () => {
  const requests: RequestInit[] = [];
  const waits: number[] = [];
  let attempt = 0;
  const result = await postSlackManufacturingEvent(
    "https://hooks.slack.com/services/T000/B000/secret",
    operationEvent,
    {
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        attempt += 1;
        return attempt === 1
          ? new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } })
          : new Response("ok", { status: 200 });
      },
      wait: async (milliseconds) => { waits.push(milliseconds); },
    },
  );
  assert.deepEqual(result, { status: "sent" });
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [2_000]);
  assert.equal(new Headers(requests[0].headers).get("Content-Type"), "application/json");
  assert.match(String(requests[0].body), /Ready for QC/);
});

test("webhook delivery skips missing configuration and rejects non-Slack URLs", async () => {
  assert.deepEqual(await postSlackManufacturingEvent("", operationEvent), { status: "skipped" });
  assert.deepEqual(await postSlackManufacturingEvent("https://example.com/services/test", operationEvent), {
    status: "failed",
    error: "SLACK_WEBHOOK_URL is not a valid Slack incoming webhook URL",
  });
});

test("Onshape correction alerts list changes, escape text, and warn when what to make changed", () => {
  const base = { type: "engineering_corrected" as const, actorName: "Alex A.", requirementId: 20, partNumber: "P-1", partName: "Fixture <plate>", assemblyNumber: "A-1" };
  const routed = formatSlackManufacturingEvent({ ...base, changes: ["Quantity: 4 → 2", "OP1: Lathe → Haas CNC"], reason: "BOM <double> count", routingChanged: true });
  assert.match(routed.text, /Onshape data corrected: P-1/);
  const blocks = JSON.stringify(routed.blocks);
  for (const pattern of [/Quantity: 4 → 2; OP1: Lathe → Haas CNC/, /Check the routing and quantity/, /BOM &lt;double&gt; count/, /Fixture &lt;plate&gt;/, /Requirement #20/]) assert.match(blocks, pattern);
  const material = formatSlackManufacturingEvent({ ...base, changes: ["Material: 6061 → 7075"] });
  assert.doesNotMatch(JSON.stringify(material.blocks), /Check the routing|Reason/);
});
