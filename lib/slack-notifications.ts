import "server-only";

import { after } from "next/server";

import { postSlackManufacturingEvent, type SlackManufacturingEvent } from "@/lib/slack-notifications-core";

export function scheduleSlackManufacturingEvent(event: SlackManufacturingEvent) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;

  after(async () => {
    const delivery = await postSlackManufacturingEvent(webhookUrl, event);
    if (delivery.status === "failed") {
      console.error(`[Slack notification] ${delivery.error ?? "Delivery failed"}`);
    }
  });
}
