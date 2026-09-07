export interface SlackPartContext {
  requirementId: number;
  partNumber: string;
  partName: string;
  assemblyNumber: string;
}

export type SlackManufacturingEvent =
  | (SlackPartContext & {
      type: "operation_claimed" | "operation_completed" | "operation_released" | "operation_reopened";
      actorName: string;
      operationNumber: string;
      workType: "CAM" | "Manufacturing";
      machine: string;
      quantity: number;
      tookOver?: boolean;
      becameReadyForQc?: boolean;
      becameComplete?: boolean;
    })
  | (SlackPartContext & {
      type: "finishing_claimed" | "finishing_completed" | "finishing_released" | "finishing_reopened";
      actorName: string;
      color: string;
      quantity: number;
      postQcWorkReady?: boolean;
      becameComplete?: boolean;
    })
  | (SlackPartContext & {
      type: "qc_reviewed";
      actorName: string;
      result: "passed" | "failed";
      notes: string;
      storageLocation?: string | null;
      forced?: boolean;
      becameReadyForFinishing?: boolean;
      postQcWorkReady?: boolean;
      becameComplete?: boolean;
    })
  | (SlackPartContext & {
      type: "qc_reopened";
      actorName: string;
    })
  | (SlackPartContext & {
      type: "location_changed";
      actorName: string;
      previousLocation: string | null;
      location: string | null;
    })
  | (SlackPartContext & {
      type: "cam_handoff_edited";
      actorName: string;
      operationNumber: string;
      machine: string;
      changedFields: string[];
    })
  | (SlackPartContext & {
      type: "admin_override";
      actorName: string;
      operationNumber: string;
      workType: "CAM" | "Manufacturing";
      machine: string;
      changes: string[];
      becameReadyForQc?: boolean;
      becameComplete?: boolean;
    });

export interface SlackWebhookPayload {
  text: string;
  blocks: Array<
    | { type: "section"; text: { type: "mrkdwn"; text: string } }
    | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  >;
}

export interface SlackDeliveryResult {
  status: "sent" | "failed" | "skipped";
  error?: string;
}

interface PostSlackOptions {
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
}

const MAX_NOTES_LENGTH = 900;
const MAX_RETRY_DELAY_MS = 5_000;

function escapeMrkdwn(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(value: string, maxLength: number) {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function plural(quantity: number, singular: string, pluralValue = `${singular}s`) {
  return quantity === 1 ? singular : pluralValue;
}

function partLabel(event: SlackPartContext) {
  return `${escapeMrkdwn(event.partNumber)} — ${escapeMrkdwn(event.partName)}`;
}

function milestoneLines(event: {
  becameReadyForQc?: boolean;
  becameReadyForFinishing?: boolean;
  postQcWorkReady?: boolean;
  becameComplete?: boolean;
}) {
  return [
    event.becameReadyForQc ? "🔍 *This part is now ready for QC.*" : "",
    event.becameReadyForFinishing ? "🎨 *This part is now ready for finishing.*" : "",
    event.postQcWorkReady ? "🔩 *Post-QC manufacturing work is now ready.*" : "",
    event.becameComplete ? "🏁 *All work for this part is complete.*" : "",
  ].filter(Boolean).map((line) => `\n${line}`).join("");
}

export function formatSlackManufacturingEvent(event: SlackManufacturingEvent): SlackWebhookPayload {
  const context = `Assembly ${escapeMrkdwn(event.assemblyNumber)} • Requirement #${event.requirementId}`;

  if (["operation_claimed", "operation_completed", "operation_released", "operation_reopened"].includes(event.type)) {
    const operationEvent = event as Extract<SlackManufacturingEvent, { type: "operation_claimed" | "operation_completed" | "operation_released" | "operation_reopened" }>;
    const isCam = operationEvent.workType === "CAM";
    const workLabel = isCam ? `CAM for ${operationEvent.operationNumber}` : `${operationEvent.operationNumber} · ${operationEvent.machine}`;
    const unit = isCam ? plural(operationEvent.quantity, "CAM task") : plural(operationEvent.quantity, "part");
    const action = operationEvent.type === "operation_claimed"
      ? operationEvent.tookOver ? "took over" : "claimed"
      : operationEvent.type === "operation_completed" ? "marked complete"
        : operationEvent.type === "operation_released" ? "released"
          : "reopened";
    const milestones = milestoneLines(operationEvent);
    const heading = operationEvent.becameReadyForQc
      ? "🔍 Ready for QC"
      : operationEvent.becameComplete ? "🏁 Part complete"
        : operationEvent.type === "operation_claimed" ? "🔧 Work claimed"
          : operationEvent.type === "operation_completed" ? "✅ Work completed"
            : operationEvent.type === "operation_released" ? "↩️ Claim released"
              : "♻️ Work reopened";
    const fallback = `${heading}: ${operationEvent.partNumber} — ${operationEvent.partName}; ${operationEvent.actorName} ${action} ${operationEvent.quantity} ${unit} for ${workLabel}`;
    return {
      text: fallback,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${heading}*\n*${partLabel(operationEvent)}*\n${escapeMrkdwn(operationEvent.actorName)} ${action} ${operationEvent.quantity} ${unit} for *${escapeMrkdwn(workLabel)}*.${milestones}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: context }] },
      ],
    };
  }

  if (["finishing_claimed", "finishing_completed", "finishing_released", "finishing_reopened"].includes(event.type)) {
    const finishingEvent = event as Extract<SlackManufacturingEvent, { type: "finishing_claimed" | "finishing_completed" | "finishing_released" | "finishing_reopened" }>;
    const action = finishingEvent.type === "finishing_claimed" ? "claimed"
      : finishingEvent.type === "finishing_completed" ? "completed"
        : finishingEvent.type === "finishing_released" ? "released"
          : "reopened";
    const heading = finishingEvent.becameComplete ? "🏁 Part complete"
      : finishingEvent.type === "finishing_claimed" ? "🎨 Finishing claimed"
        : finishingEvent.type === "finishing_completed" ? "🎨 Finishing completed"
          : finishingEvent.type === "finishing_released" ? "↩️ Finishing claim released"
            : "♻️ Finishing reopened";
    const fallback = `${heading}: ${finishingEvent.partNumber} — ${finishingEvent.partName}; ${finishingEvent.actorName} ${action} ${finishingEvent.color} finishing`;
    return {
      text: fallback,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${heading}*\n*${partLabel(finishingEvent)}*\n${escapeMrkdwn(finishingEvent.actorName)} ${action} *${escapeMrkdwn(finishingEvent.color)}* finishing for ${finishingEvent.quantity} ${plural(finishingEvent.quantity, "part")}.${milestoneLines(finishingEvent)}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: context }] },
      ],
    };
  }

  if (event.type === "qc_reopened") {
    return {
      text: `QC approval undone: ${event.partNumber} — ${event.partName}; reopened by ${event.actorName}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*♻️ QC approval undone*\n*${partLabel(event)}*\n${escapeMrkdwn(event.actorName)} reopened this part for QC.` } },
        { type: "context", elements: [{ type: "mrkdwn", text: context }] },
      ],
    };
  }

  if (event.type === "location_changed") {
    const previous = event.previousLocation ?? "Not set";
    const location = event.location ?? "Not set";
    const heading = event.location === "On Robot" ? "🤖 Part moved onto robot" : "📍 Part location changed";
    return {
      text: `${heading}: ${event.partNumber} — ${event.partName}; ${previous} to ${location}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${heading}*\n*${partLabel(event)}*\n${escapeMrkdwn(event.actorName)} changed the location from *${escapeMrkdwn(previous)}* to *${escapeMrkdwn(location)}*.` } },
        { type: "context", elements: [{ type: "mrkdwn", text: context }] },
      ],
    };
  }

  if (event.type === "cam_handoff_edited") {
    const fields = event.changedFields.length ? event.changedFields.map(escapeMrkdwn).join(", ") : "handoff details";
    return {
      text: `CAM handoff edited: ${event.partNumber} — ${event.partName}; ${event.operationNumber}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*📝 CAM handoff edited*\n*${partLabel(event)}*\n${escapeMrkdwn(event.actorName)} updated ${fields} for *CAM ${escapeMrkdwn(event.operationNumber)} · ${escapeMrkdwn(event.machine)}*.` } },
        { type: "context", elements: [{ type: "mrkdwn", text: context }] },
      ],
    };
  }

  if (event.type === "admin_override") {
    const workLabel = event.workType === "CAM" ? `CAM for ${event.operationNumber}` : `${event.operationNumber} · ${event.machine}`;
    const changes = event.changes.length ? event.changes.map(escapeMrkdwn).join("; ") : "operation details updated";
    return {
      text: `Administrator override: ${event.partNumber} — ${event.partName}; ${workLabel}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*🛠️ Administrator override*\n*${partLabel(event)}*\n${escapeMrkdwn(event.actorName)} updated *${escapeMrkdwn(workLabel)}*: ${changes}.${milestoneLines(event)}` } },
        { type: "context", elements: [{ type: "mrkdwn", text: context }] },
      ],
    };
  }

  if (event.type !== "qc_reviewed") throw new Error("Unsupported Slack manufacturing event");
  const passed = event.result === "passed";
  const heading = passed ? "✅ QC approved" : "❌ QC failed";
  const forceLabel = event.forced ? " using Force QC" : "";
  const locationLine = passed && event.storageLocation
    ? `\n*Storage:* ${escapeMrkdwn(event.storageLocation)}`
    : "";
  const notes = truncate(event.notes, MAX_NOTES_LENGTH);
  const notesLine = notes ? `\n*Notes:* ${escapeMrkdwn(notes)}` : "";
  const fallback = `${heading}: ${event.partNumber} — ${event.partName}; reviewed by ${event.actorName}${forceLabel}`;
  return {
    text: fallback,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${heading}*\n*${partLabel(event)}*\nReviewed by ${escapeMrkdwn(event.actorName)}${forceLabel}.${locationLine}${notesLine}${milestoneLines(event)}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: context }] },
    ],
  };
}

function isAllowedSlackWebhook(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "hooks.slack.com" || url.hostname === "hooks.slack-gov.com")
      && url.pathname.startsWith("/services/");
  } catch {
    return false;
  }
}

export async function postSlackManufacturingEvent(
  webhookUrl: string,
  event: SlackManufacturingEvent,
  options: PostSlackOptions = {},
): Promise<SlackDeliveryResult> {
  if (!webhookUrl.trim()) return { status: "skipped" };
  if (!isAllowedSlackWebhook(webhookUrl)) return { status: "failed", error: "SLACK_WEBHOOK_URL is not a valid Slack incoming webhook URL" };

  const request = options.fetch ?? fetch;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const payload = formatSlackManufacturingEvent(event);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "FRC190-Manufacturing/1.0" },
        body: JSON.stringify(payload),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return { status: "sent" };
      if (response.status === 429 && attempt === 0) {
        const retrySeconds = Number(response.headers.get("Retry-After") ?? 1);
        const retryDelay = Number.isFinite(retrySeconds)
          ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retrySeconds * 1_000))
          : 1_000;
        await wait(retryDelay);
        continue;
      }
      return { status: "failed", error: `Slack webhook returned HTTP ${response.status}` };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : "Slack webhook request failed" };
    }
  }

  return { status: "failed", error: "Slack webhook remained rate limited after one retry" };
}
