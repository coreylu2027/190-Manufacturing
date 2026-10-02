// A staged Onshape sync payload becomes a change list for administrators, and
// an approval becomes the payload that is actually committed. Pure: shared by
// the review API and tests. The rules mirror manufacturing_apply_engineering_sync
// (scope, deactivation, legacy re-keying) and the obsoletion trigger that runs
// after it, so the review predicts what the commit will do.

type Row = Record<string, unknown>;

export type SyncProposalStatus = "pending" | "approved" | "denied" | "superseded" | "failed";

export interface SyncAttachmentGroup {
  part_number: string;
  kind: "drawing-pdf" | "step";
  export_key: string;
  files: Array<Row & { original_name?: string; byte_size?: number }>;
}

/** Exactly what the sync sends to manufacturing_apply_engineering_sync. */
export interface SyncPayload {
  assemblies: Row[];
  parts: Row[];
  requirements: Row[];
  operations: Row[];
  finishing: Row[];
  attachments: SyncAttachmentGroup[];
  synced_roots: string[];
  discovered_roots: string[];
  discovery_master: string;
  discovery_complete: boolean;
  cad_synced: boolean;
  warnings: string[];
  source_rows?: number;
  file_groups_cached?: number;
}

export interface SyncSourceRevision {
  part_number?: string;
  name?: string;
  revision?: string;
  view_ref?: string;
}

export interface SyncProposalSummary {
  id: string;
  status: SyncProposalStatus;
  stagedAt: string;
  startedAt: string | null;
  runUrl: string | null;
  details: {
    label?: string;
    force_refresh?: boolean;
    sync_cad_files?: boolean;
    roots_checked?: number;
    source_revisions?: SyncSourceRevision[];
  };
  summary: { synced_roots?: string[]; warnings?: string[]; counts?: Record<string, number> };
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
  result: (Row & { status?: string; error?: string; committed?: boolean }) | null;
}

/** What an administrator decided on, kept after the payload is pruned. */
export interface StoredSyncReview {
  token: string;
  roots: Array<{ root: string; name: string; before: string | null; after: string; applied: boolean }>;
  changes: Array<{ id: string; kind: SyncChangeKind; root: string | null; title: string; summary: string; applied: boolean;
    fields: Array<{ id: string; label: string; before: string; after: string; applied: boolean }> }>;
}

export interface ReviewRequirement {
  id: number;
  production_key: string;
  part_id: number | null;
  part_number: string | null;
  assembly_number: string | null;
  scope_root: string | null;
  source_root: string | null;
  configuration: string | null;
  required_quantity: number | null;
  bom_positions: string | null;
  onshape_url: string | null;
  source_document: string | null;
  source_assembly_revision: string | null;
  required_part_revision: string | null;
  machine_op1: string | null;
  machine_op2: string | null;
  machine_op3: string | null;
  machine_op4: string | null;
  finishing: string | null;
  active_in_bom: boolean | null;
  obsolete: boolean | null;
  status: string | null;
  qc_outcome: string | null;
  part_location: string | null;
  off_the_shelf: boolean | null;
}

export interface ReviewPart {
  id: number;
  part_number: string;
  name: string | null;
  description: string | null;
  material: string | null;
  manufacturing_method: string | null;
  vendor: string | null;
  revision: string | null;
  onshape_url: string | null;
  category: string | null;
  drawing_url: string | null;
  active: boolean | null;
  cots: boolean | null;
}

export interface ReviewAssembly {
  id: number;
  assembly_number: string;
  subsystem_name: string | null;
  latest_released_revision: string | null;
  integration_status: string | null;
  discovery_master: string | null;
  active: boolean | null;
}

export interface ReviewOperation {
  id: number;
  requirement_id: number | null;
  operation_key: string | null;
  operation_number: string | null;
  machine: string | null;
  work_type: string | null;
  active_in_routing: boolean | null;
  status: string | null;
  claimed_quantity: number | null;
  completed_quantity: number | null;
}

export interface ReviewFinishing {
  id: number;
  requirement_id: number | null;
  production_key: string | null;
  color: string | null;
  required_quantity: number | null;
  active: boolean | null;
  machinist: string | null;
}

export interface ReviewOverride {
  entity: "parts" | "requirements";
  row_id: number;
  field: string;
  value: unknown;
  synced_value: unknown;
}

export interface ReviewAttachment {
  part_id: number;
  kind: "drawing-pdf" | "step";
  position: number;
  original_name: string;
}

/** manufacturing_engineering_sync_review_state: the proposal plus the rows it touches. */
export interface SyncReviewState {
  proposal: SyncProposalSummary & { exclusions: string[]; review: StoredSyncReview | null };
  payload: SyncPayload | null;
  stale: boolean;
  assemblies?: ReviewAssembly[];
  parts?: ReviewPart[];
  requirements?: ReviewRequirement[];
  operations?: ReviewOperation[];
  finishing?: ReviewFinishing[];
  overrides?: ReviewOverride[];
  attachments?: ReviewAttachment[];
}

export type SyncChangeKind = "added" | "restored" | "removed" | "revised" | "changed" | "part" | "files" | "membership";

export interface SyncFieldChange {
  id: string;
  label: string;
  before: string;
  after: string;
  notes: string[];
}

export interface SyncChange {
  id: string;
  kind: SyncChangeKind;
  root: string | null;
  partNumber: string | null;
  title: string;
  context: string;
  summary: string;
  /** Individually skippable field changes (changed requirements and parts). */
  fields: SyncFieldChange[];
  details: string[];
  notes: string[];
  /** Recorded shop work the change affects. */
  warnings: string[];
  excludable: boolean;
  blockedReason: string | null;
}

export interface SyncRootSummary {
  root: string;
  name: string;
  before: string | null;
  after: string;
  changes: number;
}

export interface SyncReview {
  token: string;
  roots: SyncRootSummary[];
  changes: SyncChange[];
  warnings: string[];
  notices: string[];
  /** Rows whose only differences are links, BOM positions, or revision markers. */
  bookkeeping: number;
  partial: boolean;
}

export class SyncReviewError extends Error {}

export const SYNC_CHANGE_LABELS: Record<SyncChangeKind, string> = {
  added: "New", restored: "Back in BOM", removed: "Removed", revised: "New revision", changed: "Changed",
  part: "Part details", files: "Files", membership: "Main membership",
};

const ROUTING = ["machine_op1", "machine_op2", "machine_op3", "machine_op4"] as const;
const REQUIREMENT_FIELDS = [
  { id: "quantity", label: "Quantity", columns: ["required_quantity"] },
  { id: "routing", label: "Routing", columns: [...ROUTING] },
  { id: "finishing", label: "Finishing", columns: ["finishing"] },
  { id: "source_document", label: "Source document", columns: ["source_document"] },
] as const;
const REQUIREMENT_MINOR = ["bom_positions", "onshape_url"] as const;
const PART_FIELDS = [
  { id: "name", label: "Name" },
  { id: "description", label: "Description" },
  { id: "material", label: "Material" },
  { id: "manufacturing_method", label: "Manufacturing method" },
  { id: "vendor", label: "Vendor" },
  { id: "category", label: "Category" },
  { id: "cots", label: "COTS" },
] as const;
const PART_MINOR = ["revision", "onshape_url", "drawing_url", "active"] as const;
const MISSING_FROM_MAIN = "Missing from Main — Review";

const text = (value: unknown) => value === null || value === undefined ? "" : String(value).trim();
const configuration = (value: unknown) => value === null || value === undefined ? "default" : String(value);
const finish = (value: unknown) => value === "Red" || value === "Black" ? value : "None";
const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const display = (value: unknown) => text(value) || "—";
const routing = (row: Row) => ROUTING.map((field) => text(row[field]) || null);
const routingText = (machines: Array<string | null>) => {
  const stages = machines.flatMap((machine, index) => machine ? [`OP${index + 1} ${machine}`] : []);
  return stages.length ? stages.join(" → ") : "No routing";
};
const quantityText = (value: unknown) => String(number(value));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** cyrb53: a stable fingerprint of what the administrator reviewed. */
function fingerprint(value: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

interface RequirementChangePlan {
  change: SyncChange;
  /** Payload production keys this change adds or updates. */
  newKeys: string[];
  /** Current requirements this change deactivates; they stay active when it is skipped. */
  kept: ReviewRequirement[];
  /** The matched current row for changed/restored requirements. */
  current: ReviewRequirement | null;
}

interface Analysis {
  review: SyncReview;
  plans: RequirementChangePlan[];
  partChanges: Map<string, SyncChange>;
  fileChanges: Map<string, SyncChange>;
  onshapeRequirementValue: (requirement: ReviewRequirement, column: string) => unknown;
  onshapePartValue: (part: ReviewPart, column: string) => unknown;
  partsByNumber: Map<string, ReviewPart>;
  keepBlocked: (requirement: ReviewRequirement) => string | null;
}

function analyze(state: SyncReviewState): Analysis {
  const payload = state.payload;
  if (!payload) throw new SyncReviewError("This sync proposal has no payload to review");
  const roots = new Set(payload.synced_roots.map(String));
  const requirements = state.requirements ?? [];
  const parts = state.parts ?? [];
  const operations = state.operations ?? [];
  const finishing = state.finishing ?? [];
  const overrides = new Map((state.overrides ?? []).map((row) => [`${row.entity}:${row.row_id}:${row.field}`, row]));
  const partsByNumber = new Map(parts.map((part) => [part.part_number, part]));
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const assembliesByNumber = new Map((state.assemblies ?? []).map((assembly) => [assembly.assembly_number, assembly]));
  const payloadAssemblies = new Map(payload.assemblies.map((row) => [text(row.assembly_number), row]));
  const payloadParts = new Map(payload.parts.map((row) => [text(row.part_number), row]));
  const operationsByRequirement = new Map<number, ReviewOperation[]>();
  for (const operation of operations) {
    if (operation.requirement_id === null) continue;
    operationsByRequirement.set(operation.requirement_id, [...(operationsByRequirement.get(operation.requirement_id) ?? []), operation]);
  }
  const finishingByRequirement = new Map(finishing.filter((row) => row.requirement_id !== null).map((row) => [row.requirement_id!, row]));
  const payloadOperationKeys = new Set(payload.operations.map((row) => text(row.production_key)));

  const onshapeRequirementValue = (requirement: ReviewRequirement, column: string) => {
    const override = overrides.get(`requirements:${requirement.id}:${column}`);
    return override ? override.synced_value : (requirement as unknown as Row)[column];
  };
  const onshapePartValue = (part: ReviewPart, column: string) => {
    const override = overrides.get(`parts:${part.id}:${column}`);
    return override ? override.synced_value : (part as unknown as Row)[column];
  };
  const correctionNote = (entity: "parts" | "requirements", rowId: number, columns: readonly string[], after: Row) => {
    const notes: string[] = [];
    for (const column of columns) {
      const override = overrides.get(`${entity}:${rowId}:${column}`);
      if (!override) continue;
      const label = column.startsWith("machine_op") ? `OP${column.slice(-1)}` : column.replaceAll("_", " ");
      notes.push(JSON.stringify(after[column] ?? null) === JSON.stringify(override.value ?? null)
        ? `Onshape now matches the shop's ${label} correction; the correction retires.`
        : `The shop's ${label} correction (${display(override.value)}) stays in effect.`);
    }
    return notes;
  };

  const partLabel = (partNumber: string) => {
    const name = text(payloadParts.get(partNumber)?.name) || text(partsByNumber.get(partNumber)?.name);
    return name ? `${partNumber} · ${name}` : partNumber;
  };
  const contextOf = (row: { assembly_number?: unknown; configuration?: unknown; source_document?: unknown }) => [
    text(row.assembly_number) || "No assembly",
    configuration(row.configuration) !== "default" ? `config ${configuration(row.configuration)}` : "",
    text(row.source_document),
  ].filter(Boolean).join(" · ");
  const slotOf = (root: unknown, assembly: unknown, part: unknown, config: unknown) =>
    [text(root), text(assembly), text(part), text(configuration(config)) || "default"].join("|");

  const workWarnings = (requirement: ReviewRequirement) => {
    const warnings: string[] = [];
    const ops = operationsByRequirement.get(requirement.id) ?? [];
    const label = (operation: ReviewOperation) => `${operation.work_type === "CAM" ? "CAM " : ""}${text(operation.operation_number)} ${text(operation.machine)}`.trim();
    const claimed = ops.filter((operation) => number(operation.claimed_quantity) > 0 || operation.status === "In Progress");
    const completed = ops.filter((operation) => number(operation.completed_quantity) > 0);
    if (claimed.length) warnings.push(`Claimed work: ${claimed.map(label).join(", ")}`);
    if (completed.length) warnings.push(`Completed work: ${completed.map((operation) => `${label(operation)} (${number(operation.completed_quantity)})`).join(", ")}`);
    if (requirement.qc_outcome === "Passed") warnings.push("QC passed");
    if (requirement.part_location === "On Robot") warnings.push("Recorded On Robot");
    else if (requirement.part_location) warnings.push(`Stored at ${requirement.part_location}`);
    if (finishingByRequirement.get(requirement.id)?.machinist) warnings.push("Finishing is claimed");
    return warnings;
  };
  const keepBlocked = (requirement: ReviewRequirement) => {
    const root = text(requirement.scope_root);
    const expected = [root, text(requirement.required_part_revision), text(requirement.assembly_number),
      text(requirement.part_number), configuration(requirement.configuration), "v2"].join("|");
    if (!requirement.part_number || requirement.part_id === null) return "This requirement has no part and can't be kept.";
    if (requirement.production_key !== expected || (text(requirement.source_root) && text(requirement.source_root) !== root)) {
      return "This requirement predates revision-stable keys, so it can't be carried forward. Correct it after applying.";
    }
    if (onshapeRequirementValue(requirement, "required_quantity") === null) return "This requirement has no quantity and can't be kept.";
    return null;
  };

  // Match payload requirements to current rows: exact key, then the single
  // active legacy row the v2 migration re-keys in place.
  const byKey = new Map(requirements.map((row) => [row.production_key, row]));
  const matched = new Map<string, ReviewRequirement>();
  const legacy = new Set<string>();
  const used = new Set<number>();
  const notices: string[] = [];
  for (const row of payload.requirements) {
    const current = byKey.get(text(row.production_key));
    if (current) { matched.set(text(row.production_key), current); used.add(current.id); }
  }
  for (const row of payload.requirements) {
    const key = text(row.production_key);
    if (matched.has(key)) continue;
    const candidates = requirements.filter((current) => !used.has(current.id) && current.active_in_bom !== false
      && (text(current.source_root) || (current.production_key.split("|").length >= 5 ? current.production_key.split("|")[0] : "")) === text(row.source_root)
      && text(current.assembly_number) === text(row.assembly_number) && current.part_number === text(row.part_number)
      && configuration(current.configuration) === configuration(row.configuration)
      && (text(current.required_part_revision) || text(current.part_id !== null ? partsById.get(current.part_id)?.revision : "")) === text(row.required_part_revision));
    if (candidates.length > 1) notices.push(`${partLabel(text(row.part_number))} matches several legacy requirements; approving will fail until they are cleaned up.`);
    if (candidates.length === 1) { matched.set(key, candidates[0]); used.add(candidates[0].id); legacy.add(key); }
  }

  const removed = requirements.filter((row) => row.scope_root !== null && roots.has(row.scope_root)
    && row.active_in_bom !== false && !used.has(row.id));
  const added = payload.requirements.filter((row) => !matched.has(text(row.production_key)));
  const activeAfter = new Map<string, number>();
  for (const row of payload.requirements) {
    const slot = slotOf(row.source_root, row.assembly_number, row.part_number, row.configuration);
    activeAfter.set(slot, (activeAfter.get(slot) ?? 0) + 1);
  }
  const duplicateOperations = payload.operations.some((row) =>
    operations.filter((operation) => operation.operation_key === text(row.operation_key)).length > 1);
  const partial = payload.warnings.length > 0 || duplicateOperations;
  if (partial) notices.push("This sync has warnings, so it commits as partial: requirements removed from the BOM are deactivated but not marked obsolete.");

  const obsoletionNote = (old: ReviewRequirement, replacement: Row | null) => {
    if (old.obsolete) return "Already obsolete.";
    if (!text(old.source_root)) return "Deactivated. It has no source root, so it isn't marked obsolete.";
    if (partial) return "Deactivated but not marked obsolete, because this sync has warnings.";
    const slot = slotOf(old.source_root, old.assembly_number, old.part_number, old.configuration);
    const active = activeAfter.get(slot) ?? 0;
    if (!replacement) return active === 0 ? "Marked obsolete: removed from the BOM. Claimants get a stop-work alert." : "Deactivated; another requirement for this part stays active.";
    const hasRouting = payload.operations.some((operation) => text(operation.production_key) === text(replacement.production_key));
    if (active === 1 && hasRouting && text(old.required_part_revision) && text(old.required_part_revision) !== text(replacement.required_part_revision)) {
      return `Marked obsolete and replaced by rev ${display(replacement.required_part_revision)}. Claimants get a stop-work alert.`;
    }
    return "Deactivated but not marked obsolete (the replacement has no routing or isn't unique).";
  };
  const addedDetails = (row: Row) => {
    const details = [`Quantity ${quantityText(row.required_quantity)}`, routingText(routing(row))];
    if (finish(row.finishing) !== "None") details.push(`Finishing ${finish(row.finishing)}`);
    if (!partsByNumber.has(text(row.part_number))) details.push("New part");
    if (payloadParts.get(text(row.part_number))?.cots === true) details.push("COTS");
    return details;
  };

  const plans: RequirementChangePlan[] = [];
  const newBySlot = new Map<string, Row[]>();
  for (const row of added) {
    const slot = slotOf(row.source_root, row.assembly_number, row.part_number, row.configuration);
    newBySlot.set(slot, [...(newBySlot.get(slot) ?? []), row]);
  }
  const removedBySlot = new Map<string, ReviewRequirement[]>();
  for (const row of removed) {
    const slot = slotOf(row.source_root || row.scope_root, row.assembly_number, row.part_number, row.configuration);
    removedBySlot.set(slot, [...(removedBySlot.get(slot) ?? []), row]);
  }
  const revisedSlots = new Set([...newBySlot].filter(([slot, rows]) => rows.length === 1 && removedBySlot.has(slot)).map(([slot]) => slot));

  for (const slot of revisedSlots) {
    const row = newBySlot.get(slot)![0];
    const olds = removedBySlot.get(slot)!;
    const blocked = olds.map(keepBlocked).find(Boolean) ?? null;
    plans.push({
      newKeys: [text(row.production_key)], kept: olds, current: null,
      change: {
        id: `revise:${text(row.production_key)}`, kind: "revised", root: text(row.source_root), partNumber: text(row.part_number),
        title: partLabel(text(row.part_number)), context: contextOf(row),
        summary: `Rev ${olds.map((old) => display(old.required_part_revision)).join(", ")} → rev ${display(row.required_part_revision)}`,
        fields: [], details: addedDetails(row),
        notes: olds.map((old) => `Rev ${display(old.required_part_revision)} (#${old.id}): ${obsoletionNote(old, row)}`),
        warnings: olds.flatMap(workWarnings), excludable: !blocked,
        blockedReason: blocked,
      },
    });
  }
  for (const row of added) {
    const slot = slotOf(row.source_root, row.assembly_number, row.part_number, row.configuration);
    if (revisedSlots.has(slot)) continue;
    plans.push({
      newKeys: [text(row.production_key)], kept: [], current: null,
      change: {
        id: `add:${text(row.production_key)}`, kind: "added", root: text(row.source_root), partNumber: text(row.part_number),
        title: partLabel(text(row.part_number)), context: contextOf(row),
        summary: `New requirement for rev ${display(row.required_part_revision)}`,
        fields: [], details: addedDetails(row), notes: [], warnings: [], excludable: true, blockedReason: null,
      },
    });
  }
  for (const old of removed) {
    const slot = slotOf(old.source_root || old.scope_root, old.assembly_number, old.part_number, old.configuration);
    if (revisedSlots.has(slot)) continue;
    const blocked = keepBlocked(old);
    plans.push({
      newKeys: [], kept: [old], current: null,
      change: {
        id: `remove:${old.production_key}`, kind: "removed", root: old.scope_root, partNumber: old.part_number,
        title: partLabel(text(old.part_number)), context: contextOf(old),
        summary: `No longer in the released BOM (rev ${display(old.required_part_revision)}, quantity ${quantityText(old.required_quantity)})`,
        fields: [], details: [], notes: [obsoletionNote(old, null)], warnings: workWarnings(old),
        excludable: !blocked, blockedReason: blocked,
      },
    });
  }

  let bookkeeping = 0;
  for (const row of payload.requirements) {
    const key = text(row.production_key);
    const current = matched.get(key);
    if (!current) continue;
    const fields: SyncFieldChange[] = [];
    for (const field of REQUIREMENT_FIELDS) {
      const before = field.id === "routing" ? routingText(ROUTING.map((column) => text(onshapeRequirementValue(current, column)) || null))
        : field.id === "quantity" ? quantityText(onshapeRequirementValue(current, "required_quantity"))
          : field.id === "finishing" ? finish(onshapeRequirementValue(current, "finishing")) : display(current.source_document);
      const after = field.id === "routing" ? routingText(routing(row)) : field.id === "quantity" ? quantityText(row.required_quantity)
        : field.id === "finishing" ? finish(row.finishing) : display(row.source_document);
      if (before === after) continue;
      fields.push({ id: `change:${key}#${field.id}`, label: field.label, before, after, notes: correctionNote("requirements", current.id, field.columns, row) });
    }
    const restored = current.active_in_bom === false;
    const minor = REQUIREMENT_MINOR.some((column) => text(current[column]) !== text(row[column]));
    if (!fields.length && !restored) {
      if (minor || legacy.has(key)) bookkeeping++;
      continue;
    }
    const warnings: string[] = [];
    const notes: string[] = [];
    const ops = (operationsByRequirement.get(current.id) ?? []).filter((operation) => operation.work_type === "Manufacturing" && operation.active_in_routing);
    const quantity = fields.find((field) => field.id.endsWith("#quantity"));
    if (quantity) {
      const made = Math.max(0, ...ops.map((operation) => number(operation.completed_quantity)));
      if (made > number(row.required_quantity)) warnings.push(`Already completed ${made}; Onshape now needs ${quantityText(row.required_quantity)}.`);
      if (current.qc_outcome === "Passed") warnings.push("QC already passed at the old quantity.");
    }
    if (fields.some((field) => field.id.endsWith("#routing"))) {
      ROUTING.forEach((column, index) => {
        const next = text(row[column]) || null;
        if ((text(onshapeRequirementValue(current, column)) || null) === next) return;
        const operation = ops.find((candidate) => candidate.operation_number === `OP${index + 1}`);
        if (operation && (number(operation.claimed_quantity) > 0 || number(operation.completed_quantity) > 0 || operation.status === "In Progress")) {
          warnings.push(`OP${index + 1} ${display(operation.machine)} has recorded work; ${next ? `it becomes ${next}` : "it leaves the routing"}.`);
        }
      });
    }
    if (fields.some((field) => field.id.endsWith("#finishing")) && finishingByRequirement.get(current.id)?.machinist) {
      warnings.push("Finishing is claimed.");
    }
    if (current.off_the_shelf) notes.push("Off the shelf in the app: routing and finishing stay retired.");
    if (current.obsolete) notes.push(restored ? "This requirement is obsolete. Restore it in Production if it should be made again." : "This requirement is obsolete.");
    if (legacy.has(key)) notes.push(`Re-keys legacy requirement #${current.id} in place.`);
    if (!payloadOperationKeys.has(key) && !current.off_the_shelf && routing(row).some(Boolean)) notes.push("No operations are sent for this requirement.");
    plans.push({
      newKeys: [key], kept: [], current,
      change: {
        id: `${restored ? "restore" : "change"}:${key}`, kind: restored ? "restored" : "changed", root: text(row.source_root),
        partNumber: text(row.part_number), title: partLabel(text(row.part_number)), context: contextOf(row),
        summary: restored ? `Returns to the BOM (requirement #${current.id})` : fields.map((field) => `${field.label} ${field.before} → ${field.after}`).join("; "),
        // Restoring is all-or-nothing; its field differences are shown as details.
        fields: restored ? [] : fields,
        details: restored ? [...fields.map((field) => `${field.label} ${field.before} → ${field.after}`), ...addedDetails(row).slice(0, 2)] : [],
        notes, warnings, excludable: true, blockedReason: null,
      },
    });
  }

  const partChanges = new Map<string, SyncChange>();
  const rootOfPart = new Map<string, string>();
  for (const row of payload.requirements) if (!rootOfPart.has(text(row.part_number))) rootOfPart.set(text(row.part_number), text(row.source_root));
  for (const row of payload.parts) {
    const partNumber = text(row.part_number);
    const current = partsByNumber.get(partNumber);
    if (!current) continue;
    const fields: SyncFieldChange[] = [];
    for (const field of PART_FIELDS) {
      if (!(field.id in row)) continue;
      const beforeValue = onshapePartValue(current, field.id);
      const before = field.id === "cots" ? (beforeValue ? "Yes" : "No") : display(beforeValue);
      const after = field.id === "cots" ? (row.cots ? "Yes" : "No") : display(row[field.id]);
      if (before === after) continue;
      fields.push({ id: `part:${partNumber}#${field.id}`, label: field.label, before, after, notes: correctionNote("parts", current.id, [field.id], row) });
    }
    if (!fields.length) {
      if (PART_MINOR.some((column) => column in row && text(current[column]) !== text(row[column]))) bookkeeping++;
      continue;
    }
    partChanges.set(partNumber, {
      id: `part:${partNumber}`, kind: "part", root: rootOfPart.get(partNumber) ?? null, partNumber,
      title: partLabel(partNumber), context: "Applies to every requirement for this part",
      summary: fields.map((field) => `${field.label} ${field.before} → ${field.after}`).join("; "),
      fields, details: [], notes: [], warnings: [], excludable: true, blockedReason: null,
    });
  }

  const fileChanges = new Map<string, SyncChange>();
  const attachmentNames = new Map<string, string[]>();
  for (const attachment of state.attachments ?? []) {
    const part = partsById.get(attachment.part_id);
    if (!part) continue;
    const key = `${part.part_number}:${attachment.kind}`;
    attachmentNames.set(key, [...(attachmentNames.get(key) ?? []), attachment.original_name]);
  }
  for (const group of payload.attachments) {
    const partNumber = text(group.part_number);
    const kind = group.kind === "drawing-pdf" ? "Drawing PDF" : "STEP file";
    const previous = attachmentNames.get(`${partNumber}:${group.kind}`) ?? [];
    const names = group.files.map((file) => text(file.original_name)).filter(Boolean);
    const id = `files:${partNumber}:${group.kind}`;
    fileChanges.set(id, {
      id, kind: "files", root: rootOfPart.get(partNumber) ?? null, partNumber, title: partLabel(partNumber),
      context: kind, summary: previous.length ? `Replaces ${previous.join(", ")}` : `First ${kind.toLowerCase()}`,
      fields: [], details: names.length ? [`New: ${names.join(", ")}`] : [], notes: [], warnings: [], excludable: true, blockedReason: null,
    });
  }

  const membership: SyncChange[] = [];
  if (payload.discovery_master && payload.discovery_complete) {
    const discovered = new Set(payload.discovered_roots.map(String));
    for (const assembly of state.assemblies ?? []) {
      if (assembly.discovery_master !== payload.discovery_master) continue;
      const missing = !discovered.has(assembly.assembly_number);
      if (missing === (assembly.integration_status === MISSING_FROM_MAIN)) continue;
      membership.push({
        id: `member:${assembly.assembly_number}`, kind: "membership", root: null, partNumber: assembly.assembly_number,
        title: assembly.subsystem_name ? `${assembly.assembly_number} · ${assembly.subsystem_name}` : assembly.assembly_number,
        context: "Main discovery", summary: missing ? "No longer a direct child of Main; flagged for review. Its requirements stay active." : "Back in Main",
        fields: [], details: [], notes: [], warnings: [], excludable: false, blockedReason: "Membership updates always apply.",
      });
    }
  }

  const order: Record<SyncChangeKind, number> = { removed: 0, revised: 1, changed: 2, restored: 3, added: 4, part: 5, files: 6, membership: 7 };
  const changes = [...plans.map((plan) => plan.change), ...partChanges.values(), ...fileChanges.values(), ...membership]
    .sort((a, b) => order[a.kind] - order[b.kind] || text(a.root).localeCompare(text(b.root)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const rootsSummary: SyncRootSummary[] = payload.synced_roots.map((root) => {
    const record = payloadAssemblies.get(root);
    return {
      root,
      name: text(record?.subsystem_name) || text(assembliesByNumber.get(root)?.subsystem_name),
      before: assembliesByNumber.get(root)?.latest_released_revision ?? null,
      after: text(record?.latest_released_revision),
      changes: changes.filter((change) => change.root === root).length,
    };
  });
  const review: SyncReview = {
    token: "", roots: rootsSummary, changes, warnings: [...payload.warnings], notices, bookkeeping, partial,
  };
  review.token = fingerprint(JSON.stringify([state.proposal.id, state.proposal.status, state.stale, rootsSummary,
    changes.map((change) => [change.id, change.summary, change.details, change.excludable,
      change.fields.map((field) => [field.id, field.before, field.after])])]));
  return { review, plans, partChanges, fileChanges, onshapeRequirementValue, onshapePartValue, partsByNumber, keepBlocked };
}

export function buildSyncReview(state: SyncReviewState): SyncReview {
  return analyze(state).review;
}

/** Every exclusion ID the review offers, with whether it may be excluded. */
export function syncExclusionIds(review: SyncReview) {
  const ids = new Map<string, boolean>();
  for (const root of review.roots) ids.set(`root:${root.root}`, true);
  for (const change of review.changes) {
    ids.set(change.id, change.excludable);
    for (const field of change.fields) ids.set(field.id, change.excludable);
  }
  return ids;
}

/**
 * The payload to commit after the administrator's exclusions. Skipped changes
 * keep the shop's current engineering values: removed requirements are sent
 * again with their current (Onshape-side) values so they stay active, and
 * skipped field changes are sent with the value Onshape last delivered, so
 * shop corrections neither retire nor move.
 */
export function buildApprovedPayload(state: SyncReviewState, exclusions: readonly string[]): { payload: SyncPayload; review: StoredSyncReview } {
  const analysis = analyze(state);
  const payload = state.payload!;
  const allowed = syncExclusionIds(analysis.review);
  const excluded = new Set(exclusions);
  for (const id of excluded) {
    if (!allowed.has(id)) throw new SyncReviewError("The proposed changes changed while you were reviewing. Review them again.");
    if (!allowed.get(id)) throw new SyncReviewError("One of the skipped changes can't be skipped.");
  }
  const excludedRoots = new Set(payload.synced_roots.filter((root) => excluded.has(`root:${root}`)));
  const roots = payload.synced_roots.filter((root) => !excludedRoots.has(root));
  const rootRevision = new Map(payload.assemblies.map((row) => [text(row.assembly_number), row.latest_released_revision]));
  const requirements = new Map(payload.requirements.filter((row) => !excludedRoots.has(text(row.source_root)))
    .map((row) => [text(row.production_key), { ...row }]));
  const rebuildRouting = new Set<string>();
  const rebuildFinishing = new Set<string>();
  const extraParts = new Map<string, Row>();
  const partsSendCots = payload.parts.some((row) => "cots" in row);

  const keep = (current: ReviewRequirement) => {
    const blocked = analysis.keepBlocked(current);
    if (blocked) throw new SyncReviewError(blocked);
    const root = text(current.scope_root);
    const row: Row = {
      production_key: current.production_key, part_number: current.part_number, assembly_number: current.assembly_number ?? "",
      configuration: configuration(current.configuration), required_quantity: number(analysis.onshapeRequirementValue(current, "required_quantity")),
      bom_positions: current.bom_positions ?? "", onshape_url: current.onshape_url ?? "", source_document: current.source_document ?? "",
      source_root: root, source_assembly_revision: rootRevision.get(root), required_part_revision: current.required_part_revision ?? "",
      finishing: finish(analysis.onshapeRequirementValue(current, "finishing")), active_in_bom: true,
      ...Object.fromEntries(ROUTING.map((column) => [column, text(analysis.onshapeRequirementValue(current, column)) || null])),
    };
    requirements.set(current.production_key, row);
    rebuildRouting.add(current.production_key);
    rebuildFinishing.add(current.production_key);
    const partNumber = text(current.part_number);
    const part = analysis.partsByNumber.get(partNumber);
    if (part && !payload.parts.some((candidate) => text(candidate.part_number) === partNumber)) {
      extraParts.set(partNumber, {
        part_number: partNumber, name: analysis.onshapePartValue(part, "name"), description: analysis.onshapePartValue(part, "description"),
        material: analysis.onshapePartValue(part, "material"), manufacturing_method: part.manufacturing_method, vendor: part.vendor,
        revision: part.revision, onshape_url: part.onshape_url, category: part.category, drawing_url: part.drawing_url,
        active: part.active ?? true, ...(partsSendCots ? { cots: part.cots === true } : {}),
      });
    }
  };
  const revert = (key: string, current: ReviewRequirement, fieldIds: string[]) => {
    const row = requirements.get(key);
    if (!row) return;
    for (const fieldId of fieldIds) {
      if (fieldId === "quantity") {
        row.required_quantity = number(analysis.onshapeRequirementValue(current, "required_quantity"));
        rebuildFinishing.add(key);
      } else if (fieldId === "routing") {
        for (const column of ROUTING) row[column] = text(analysis.onshapeRequirementValue(current, column)) || null;
        rebuildRouting.add(key);
      } else if (fieldId === "finishing") {
        row.finishing = finish(analysis.onshapeRequirementValue(current, "finishing"));
        rebuildFinishing.add(key);
      } else if (fieldId === "source_document") row.source_document = current.source_document ?? "";
      else if (fieldId === "minor") for (const column of REQUIREMENT_MINOR) row[column] = current[column] ?? "";
    }
  };

  for (const plan of analysis.plans) {
    const change = plan.change;
    if (change.root && excludedRoots.has(change.root)) continue;
    if (excluded.has(change.id)) {
      for (const key of plan.newKeys) {
        // A skipped edit keeps the current values; a skipped addition or return stays out.
        if (change.kind === "changed" && plan.current) revert(key, plan.current, ["quantity", "routing", "finishing", "source_document", "minor"]);
        else requirements.delete(key);
      }
      for (const current of plan.kept) keep(current);
      continue;
    }
    if (plan.current) {
      const skipped = change.fields.filter((field) => excluded.has(field.id)).map((field) => field.id.split("#")[1]);
      if (skipped.length) revert(plan.newKeys[0], plan.current, skipped);
    }
  }

  const finalRequirements = [...requirements.values()];
  const keys = new Set(finalRequirements.map((row) => text(row.production_key)));
  const operations = payload.operations.filter((row) => keys.has(text(row.production_key)) && !rebuildRouting.has(text(row.production_key)));
  const finishing = payload.finishing.filter((row) => keys.has(text(row.production_key)) && !rebuildFinishing.has(text(row.production_key)));
  for (const key of rebuildRouting) {
    const row = requirements.get(key);
    if (!row) continue;
    ROUTING.forEach((column, index) => {
      const machine = text(row[column]);
      if (machine) operations.push({ operation_key: `${key}|OP${index + 1}`, production_key: key, operation_number: `OP${index + 1}`,
        machine, active_in_routing: true, work_type: "Manufacturing" });
    });
  }
  for (const key of rebuildFinishing) {
    const row = requirements.get(key);
    if (row && (row.finishing === "Red" || row.finishing === "Black")) {
      finishing.push({ production_key: key, color: row.finishing, required_quantity: row.required_quantity, active: true });
    }
  }

  const partNumbers = new Set(finalRequirements.map((row) => text(row.part_number)));
  const parts = payload.parts.filter((row) => partNumbers.has(text(row.part_number))).map((row) => ({ ...row }));
  for (const [partNumber, row] of extraParts) if (partNumbers.has(partNumber)) parts.push(row);
  for (const part of parts) {
    const partNumber = text(part.part_number);
    const change = analysis.partChanges.get(partNumber);
    const current = analysis.partsByNumber.get(partNumber);
    if (!change || !current) continue;
    for (const field of change.fields) {
      if (!excluded.has(change.id) && !excluded.has(field.id)) continue;
      const column = field.id.split("#")[1];
      part[column] = column === "cots" ? current.cots === true : analysis.onshapePartValue(current, column);
    }
  }
  const attachments = payload.attachments.filter((group) => partNumbers.has(text(group.part_number))
    && !excluded.has(`files:${text(group.part_number)}:${group.kind}`));
  const assemblyNumbers = new Set([...roots, ...finalRequirements.map((row) => text(row.assembly_number)).filter(Boolean)]);
  const assemblies = payload.assemblies.filter((row) => {
    const number = text(row.assembly_number);
    return !excludedRoots.has(number) && assemblyNumbers.has(number);
  });

  if (!roots.length && !payload.discovery_master) throw new SyncReviewError("Every root is skipped. Deny the sync instead.");
  const approved: SyncPayload = roots.length ? {
    ...payload, assemblies, parts, requirements: finalRequirements, operations, finishing, attachments, synced_roots: roots,
  } : {
    // Membership bookkeeping only: the engineering RPC rejects any rows without a root scope.
    ...payload, assemblies: [], parts: [], requirements: [], operations: [], finishing: [], attachments: [], synced_roots: [],
  };
  const applied = (change: SyncChange) => !excluded.has(change.id) && !(change.root && excludedRoots.has(change.root));
  const review: StoredSyncReview = {
    token: analysis.review.token,
    roots: analysis.review.roots.map((root) => ({ root: root.root, name: root.name, before: root.before, after: root.after, applied: !excludedRoots.has(root.root) })),
    changes: analysis.review.changes.map((change) => ({
      id: change.id, kind: change.kind, root: change.root, title: change.title, summary: change.summary, applied: applied(change),
      fields: change.fields.map((field) => ({ id: field.id, label: field.label, before: field.before, after: field.after,
        applied: applied(change) && !excluded.has(field.id) })),
    })),
  };
  return { payload: approved, review };
}

/** The record kept for a denial: every change, none applied. */
export function deniedReview(state: SyncReviewState): StoredSyncReview | null {
  if (!state.payload) return null;
  const { review } = analyze(state);
  return {
    token: review.token,
    roots: review.roots.map((root) => ({ root: root.root, name: root.name, before: root.before, after: root.after, applied: false })),
    changes: review.changes.map((change) => ({ id: change.id, kind: change.kind, root: change.root, title: change.title,
      summary: change.summary, applied: false,
      fields: change.fields.map((field) => ({ id: field.id, label: field.label, before: field.before, after: field.after, applied: false })) })),
  };
}

export function syncChangeCounts(changes: readonly Pick<SyncChange, "kind">[]) {
  const counts = Object.fromEntries(Object.keys(SYNC_CHANGE_LABELS).map((kind) => [kind, 0])) as Record<SyncChangeKind, number>;
  for (const change of changes) counts[change.kind]++;
  return counts;
}

export function describeSyncResult(result: SyncProposalSummary["result"]) {
  if (!result) return "";
  if (result.status === "failed") return `Rolled back: ${text(result.error) || "unknown error"}`;
  if (result.status === "denied") return "Denied; nothing was committed.";
  const deactivated = number(result.deactivated);
  return [result.status === "partial" ? "Committed with warnings" : "Committed",
    deactivated ? `${plural(deactivated, "requirement")} deactivated` : ""].filter(Boolean).join(" · ");
}
