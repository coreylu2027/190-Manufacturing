// Turns the raw per-requirement history (write_history rows grouped by write
// request, QC reviews, and correction events) into readable timeline entries.
import { CORRECTION_FIELD_LABELS } from "./engineering-overrides.ts";

type Change = [unknown, unknown];
export interface HistoryRow {
  entity: "requirements" | "operations" | "finishing" | "parts";
  rowId: number;
  created: boolean;
  operationNumber: string | null;
  machine: string | null;
  workType: string | null;
  changes: Record<string, Change>;
}
export interface HistoryCorrection {
  entity: "requirements" | "parts";
  field: string;
  action: "set" | "cleared" | "retired";
  value: unknown;
  syncedValue: unknown;
  reason: string | null;
}
export interface HistoryWrite {
  requestId: string;
  action: string;
  at: string;
  actor: string;
  rows: HistoryRow[];
  corrections: HistoryCorrection[];
}
export interface HistoryReview {
  id: number;
  result: "passed" | "failed";
  notes: string | null;
  rejectedQuantity: number | null;
  at: string;
  reviewer: string;
  retractedAt: string | null;
  retractedBy: string | null;
}
export interface HistorySyncEvent extends Omit<HistoryCorrection, "reason"> {
  id: number;
  at: string;
}
/** The shape returned by `manufacturing_requirement_history`. */
export interface RequirementHistoryPayload {
  requirementId: number;
  writes: HistoryWrite[];
  syncEvents: HistorySyncEvent[];
  reviews: HistoryReview[];
}

export type HistoryTone = "work" | "qc-pass" | "qc-fail" | "correction" | "location" | "note" | "status";
export interface HistoryEntry {
  id: string;
  at: string;
  actor: string | null;
  title: string;
  details: string[];
  tone: HistoryTone;
}

/** A QC review and the write that recorded it are separate rows; they pair up within this window. */
const REVIEW_PAIRING_MS = 2 * 60_000;
const ACTION_TITLES: Record<string, string> = {
  claim: "Claimed work", release: "Released work", complete: "Completed work", undo_complete: "Undid completed work",
  steal: "Took over a claim", patch_operation: "Updated an operation", cam_handoff: "Updated the CAM handoff",
  finishing_claim: "Claimed finishing", finishing_release: "Released finishing", finishing_complete: "Completed finishing",
  finishing_undo_complete: "Reopened finishing", finishing_steal: "Took over finishing",
  qc_review: "Recorded a QC review", qc_undo: "Undid the QC review", part_location: "Updated the location",
  requirement_note: "Edited production notes", requirement_obsoletion: "Changed obsolete status",
  requirement_visibility: "Changed visibility", engineering_override: "Corrected Onshape data",
  attachment_override: "Replaced a file", rename: "Renamed a machinist",
};

const count = (value: unknown) => Number(value ?? 0) || 0;
const parts = (quantity: number) => `${quantity} part${quantity === 1 ? "" : "s"}`;
const display = (value: unknown) => value === null || value === undefined || value === "" ? "—" : String(value);
const excerpt = (value: unknown, length = 140) => {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};
const time = (value: string) => new Date(value).getTime();

function operationLabel(row: HistoryRow) {
  const operation = row.operationNumber ?? "Operation";
  return row.workType === "CAM" ? `CAM for ${operation}` : `${operation} · ${row.machine ?? "Unassigned"}`;
}

function operationLines(row: HistoryRow, action: string): string[] {
  const label = operationLabel(row);
  if (row.created) return [`Added ${label}`];
  const lines: string[] = [];
  const { changes } = row;
  if ("active_in_routing" in changes) lines.push(changes.active_in_routing[1] ? `Restored ${label} to the routing` : `Removed ${label} from the routing`);
  if ("machine" in changes) lines.push(`${row.operationNumber ?? "Operation"}: ${display(changes.machine[0])} → ${display(changes.machine[1])}`);
  const completed = "completed_quantity" in changes ? count(changes.completed_quantity[1]) - count(changes.completed_quantity[0]) : 0;
  const claimed = "claimed_quantity" in changes ? count(changes.claimed_quantity[1]) - count(changes.claimed_quantity[0]) : 0;
  const cam = row.workType === "CAM";
  if (completed > 0) lines.push(cam ? `Completed ${label}` : `Completed ${parts(completed)} on ${label}`);
  else if (completed < 0) lines.push(action === "qc_review" ? `Sent ${parts(-completed)} on ${label} back for rework`
    : cam ? `Reopened ${label}` : `Undid ${parts(-completed)} completed on ${label}`);
  else if (action === "steal") lines.push(`Took over the claim on ${label}`);
  else if (claimed > 0) lines.push(cam ? `Claimed ${label}` : `Claimed ${parts(claimed)} on ${label}`);
  else if (claimed < 0) lines.push(cam ? `Released ${label}` : `Released ${parts(-claimed)} on ${label}`);
  if ("cam_program_path" in changes || "cam_notes" in changes) lines.push(`Updated the CAM program or notes for ${row.operationNumber ?? "the operation"}`);
  // Readiness is re-planned on most writes; a status change is only news when someone set it directly.
  if (action === "patch_operation" && "status" in changes) lines.push(`${label}: ${display(changes.status[0])} → ${display(changes.status[1])}`);
  return lines;
}

function requirementLines(row: HistoryRow, corrections: HistoryCorrection[]): string[] {
  const { changes } = row;
  const lines: string[] = [];
  if ("part_location" in changes) lines.push(changes.part_location[1] ? `Moved to ${changes.part_location[1]}` : "Cleared the location");
  if ("production_notes" in changes) lines.push(String(changes.production_notes[1] ?? "").trim()
    ? `Production notes: “${excerpt(changes.production_notes[1])}”` : "Cleared the production notes");
  if ("obsolete" in changes) lines.push(changes.obsolete[1] ? "Marked obsolete" : "Restored from obsolete");
  if ("hidden" in changes) lines.push(changes.hidden[1] ? "Hidden from production lists" : "Shown in production lists again");
  if ("off_the_shelf" in changes && !corrections.some((correction) => correction.field === "off_the_shelf")) {
    lines.push(changes.off_the_shelf[1] ? "Marked off-the-shelf" : "Switched back to manufactured");
  }
  return lines;
}

function finishingLine(action: string) {
  return {
    finishing_claim: "Claimed finishing", finishing_release: "Released finishing", finishing_complete: "Completed finishing",
    finishing_undo_complete: "Reopened finishing", finishing_steal: "Took over finishing", steal: "Took over finishing",
  }[action];
}

function correctionLine(correction: Pick<HistoryCorrection, "field" | "action" | "value" | "syncedValue">) {
  const label = CORRECTION_FIELD_LABELS[correction.field] ?? correction.field;
  if (correction.field === "off_the_shelf") return correction.action === "set" ? "Marked off-the-shelf" : "Switched back to manufactured";
  if (correction.field === "drawing-pdf" || correction.field === "step") {
    const name = (correction.value as { name?: string } | null)?.name;
    return correction.action === "set" ? `${label} replaced with ${name ?? "a new file"}` : `Restored the Onshape ${label}`;
  }
  if (correction.action === "retired") return `Onshape now matches the corrected ${label} (${display(correction.value)}); correction retired`;
  if (correction.action === "cleared") return `${label} reverted to Onshape’s ${display(correction.syncedValue)}`;
  return `${label} set to ${display(correction.value)} (Onshape: ${display(correction.syncedValue)})`;
}

function statusLine(write: HistoryWrite) {
  const status = write.rows.find((row) => row.entity === "requirements" && "status" in row.changes)?.changes.status;
  return status ? `Status: ${display(status[0])} → ${display(status[1])}` : null;
}

function reviewTitle(review: HistoryReview) {
  if (review.result === "passed") return "QC passed";
  return review.rejectedQuantity ? `QC failed · ${parts(review.rejectedQuantity)} rejected` : "QC failed";
}

function reviewDetails(review: HistoryReview) {
  return [
    ...(review.notes?.trim() ? [`“${excerpt(review.notes, 240)}”`] : []),
    ...(review.retractedAt ? [`Later undone${review.retractedBy ? ` by ${review.retractedBy}` : ""}`] : []),
  ];
}

/** Newest first. Writes that recorded a QC review are merged with that review. */
export function buildRequirementHistory(payload: RequirementHistoryPayload): HistoryEntry[] {
  const unpairedReviews = new Set(payload.reviews);
  const entries: HistoryEntry[] = [];

  for (const write of payload.writes) {
    const status = statusLine(write);
    if (write.action === "qc_review") {
      const review = [...unpairedReviews]
        .filter((candidate) => candidate.reviewer === write.actor && Math.abs(time(candidate.at) - time(write.at)) <= REVIEW_PAIRING_MS)
        .sort((left, right) => Math.abs(time(left.at) - time(write.at)) - Math.abs(time(right.at) - time(write.at)))[0];
      if (review) unpairedReviews.delete(review);
      const requirement = write.rows.find((row) => row.entity === "requirements");
      const notesOnly = review?.result === "passed" && requirement && Object.keys(requirement.changes).every((key) => key.startsWith("qc_") && key !== "qc_outcome");
      const work = write.rows.filter((row) => row.entity === "operations").flatMap((row) => operationLines(row, write.action));
      entries.push({
        id: write.requestId, at: write.at, actor: write.actor,
        title: notesOnly ? "Updated inspection notes" : review ? reviewTitle(review) : ACTION_TITLES.qc_review,
        details: [...(review ? reviewDetails(review) : []), ...work, ...(status ? [status] : [])],
        tone: notesOnly ? "note" : review?.result === "failed" ? "qc-fail" : "qc-pass",
      });
      continue;
    }

    const lines = [
      ...write.corrections.map(correctionLine),
      ...write.rows.flatMap((row) => row.entity === "operations" ? operationLines(row, write.action)
        : row.entity === "requirements" ? requirementLines(row, write.corrections)
          : row.entity === "finishing" ? [finishingLine(write.action) ?? ""].filter(Boolean) : []),
    ].filter((line, index, all) => all.indexOf(line) === index);
    const reason = write.corrections.find((correction) => correction.reason?.trim())?.reason?.trim();
    const grouped = write.action === "engineering_override" || write.action === "attachment_override";
    const title = grouped && lines.length !== 1 ? ACTION_TITLES[write.action] : lines[0] ?? ACTION_TITLES[write.action] ?? write.action.replaceAll("_", " ");
    entries.push({
      id: write.requestId, at: write.at, actor: write.actor, title,
      details: [...(title === lines[0] ? lines.slice(1) : lines), ...(reason ? [`Reason: ${reason}`] : []), ...(status ? [status] : [])],
      tone: grouped ? "correction" : write.action === "part_location" ? "location" : write.action === "requirement_note" ? "note"
        : ["requirement_obsoletion", "requirement_visibility"].includes(write.action) ? "status" : "work",
    });
  }

  for (const review of unpairedReviews) {
    entries.push({ id: `review:${review.id}`, at: review.at, actor: review.reviewer, title: reviewTitle(review),
      details: reviewDetails(review), tone: review.result === "failed" ? "qc-fail" : "qc-pass" });
  }
  for (const event of payload.syncEvents) {
    entries.push({ id: `sync:${event.id}`, at: event.at, actor: "Onshape sync", title: correctionLine(event), details: [], tone: "correction" });
  }
  return entries.sort((left, right) => time(right.at) - time(left.at) || right.id.localeCompare(left.id));
}
