// Pure planning for administrator corrections to synced engineering data. The
// database re-applies stored overrides after each Onshape sync; this module
// plans the edit itself, including routing, CAM prerequisites, and readiness.
import { deduplicateOperations, planRequirementWorkflow, requiresCam, requiresPassedQc, targetMachineHasStarted, type WorkflowOperationStatus } from "../manufacturing-workflow.ts";
import {
  MAX_DESCRIPTION_LENGTH, MAX_MATERIAL_LENGTH, MAX_NAME_LENGTH, MAX_OVERRIDE_QUANTITY, ROUTING_FIELDS, normalizeFinishColor, routingError,
  type EngineeringOverrideFields, type EngineeringOverrideState, type FinishColor, type OverrideField, type Routing,
} from "../engineering-overrides.ts";
import type { NormalizedRow } from "./model.ts";

export class EngineeringOverrideError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

export interface OverrideInstruction {
  entity: "parts" | "requirements";
  row_id: number;
  field: OverrideField;
  action: "set" | "clear";
  value?: unknown;
}
export interface OverrideRowChange { entity: "requirements" | "parts" | "operations" | "finishing"; id: number; patch: Record<string, unknown> }
export interface OverrideRowInsert { entity: "operations" | "finishing"; row: Record<string, unknown> }
export interface OverrideChangeSummary { field: string; from: string; to: string }

const PATCHABLE: Record<OverrideRowChange["entity"], readonly string[]> = {
  requirements: ["required_quantity", "finishing", ...ROUTING_FIELDS, "status", "qc_outcome", "off_the_shelf"],
  parts: ["material", "name", "description"],
  operations: ["machine", "active_in_routing", "status", "completed_at"],
  finishing: ["color", "required_quantity", "active"],
};

type Row = Record<string, unknown> & { id: number };
const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const count = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const operationStatus = (row: Row): WorkflowOperationStatus => {
  const status = String(row.status ?? "Planned");
  return (status === "Needs Rework" ? "Ready" : status) as WorkflowOperationStatus;
};
const isCam = (row: Row) => row.work_type === "CAM";
const hasWork = (row: Row) => targetMachineHasStarted({
  status: operationStatus(row), claimedQuantity: count(row.claimed_quantity), completedQuantity: count(row.completed_quantity),
});
const display = (value: unknown) => value === null || value === undefined || value === "" ? "—" : String(value);

export function planEngineeringOverrides({ rows, state, requirementId, fields, now = new Date().toISOString() }: {
  rows: Record<string, NormalizedRow[] | undefined>;
  state: EngineeringOverrideState;
  requirementId: number;
  fields: EngineeringOverrideFields;
  now?: string;
}) {
  const sourceRequirement = rows.requirements?.find((row) => row.id === requirementId);
  if (!sourceRequirement || state.requirement?.id !== requirementId) {
    throw new EngineeringOverrideError("Production requirement no longer exists");
  }
  const partId = Number(sourceRequirement.part_id);
  const sourcePart = rows.parts?.find((row) => row.id === partId);

  const requirement: Row = { ...sourceRequirement };
  const part: Row | null = sourcePart ? { ...sourcePart } : null;
  const operations: Row[] = (rows.operations ?? []).filter((row) => Number(row.requirement_id) === requirementId).map((row) => ({ ...row }));
  const finishingRows: Row[] = (rows.finishing ?? []).filter((row) => Number(row.requirement_id) === requirementId).map((row) => ({ ...row }));
  const insertedOperations: Row[] = [];
  let insertedFinishing: Row | null = null;
  let nextTemporaryId = -1;

  const overrides: OverrideInstruction[] = [];
  const summary: OverrideChangeSummary[] = [];

  /** Decide the override bookkeeping; returns the value the column should hold. */
  function decide<T>(entity: "parts" | "requirements", field: OverrideField, label: string, current: unknown,
    edit: { value: T } | { revert: true }, normalize: (value: unknown) => T): T | undefined {
    const rowId = entity === "parts" ? partId : requirementId;
    const existing = state.overrides.find((row) => row.entity === entity && row.row_id === rowId && row.field === field);
    const synced = normalize(existing ? existing.synced_value : current);
    if ("revert" in edit && !existing) return undefined;
    const desired = "revert" in edit ? synced : normalize(edit.value);
    let target: unknown = desired;
    let recorded = false;
    if (existing && same(desired, synced)) {
      overrides.push({ entity, row_id: rowId, field, action: "clear" });
      // The database verifies the column exactly matches the retained sync value.
      target = existing.synced_value;
      recorded = true;
    } else if (!same(desired, synced) && (!existing || !same(desired, normalize(existing.value)))) {
      overrides.push({ entity, row_id: rowId, field, action: "set", value: desired });
      recorded = true;
    }
    if (same(normalize(current), desired)) return recorded ? target as T : undefined;
    summary.push({ field: label, from: display(normalize(current)), to: display(desired) });
    return target as T;
  }

  const offTheShelfBefore = requirement.off_the_shelf === true;
  const offTheShelfAfter = fields.offTheShelf ? fields.offTheShelf.value : offTheShelfBefore;
  const offTheShelfChanged = offTheShelfAfter !== offTheShelfBefore;
  const requirementLevelEdit = fields.quantity || fields.finishing || fields.routing || offTheShelfChanged;
  if (requirementLevelEdit) {
    if (requirement.obsolete) throw new EngineeringOverrideError("This requirement is obsolete. Restore it before correcting its routing, quantity, finishing, or sourcing.");
    if (requirement.active_in_bom === false) throw new EngineeringOverrideError("This requirement is no longer active in the BOM");
  }
  if ((fields.routing || fields.finishing) && (offTheShelfBefore || offTheShelfChanged)) {
    throw new EngineeringOverrideError(offTheShelfChanged
      ? "Change off-the-shelf status separately from routing and finishing"
      : "Switch this part back to manufactured before changing its routing or finishing");
  }
  const qcPassed = requirement.qc_outcome === "Passed";
  let workflowChanged = false;
  let finishingNewlyRequired = false;
  const productionKey = String(requirement.production_key ?? "");

  const activeOperations = () => deduplicateOperations([...operations, ...insertedOperations]
    .filter((row) => row.active_in_routing)
    .map((row) => ({ id: row.id, operationKey: String(row.operation_key ?? row.id), workType: isCam(row) ? "CAM" as const : "Manufacturing" as const,
      status: operationStatus(row), claimedQuantity: count(row.claimed_quantity), completedQuantity: count(row.completed_quantity),
      startedAt: row.started_at as string | null, completedAt: row.completed_at as string | null, row })))
    .map((item) => item.row);

  /** Makes one routing stage use `desired`, preserving work and pairing CAM. */
  function routeStage(index: number, desired: string | null) {
    const operationNumber = `OP${index + 1}`;
    const manufacturingKey = `${productionKey}|${operationNumber}`;
    const camKey = `${productionKey}|CAM|${operationNumber}`;
    const stage = activeOperations().filter((row) => !isCam(row) && row.operation_number === operationNumber);
    const activeCam = activeOperations().find((row) => isCam(row) && row.operation_number === operationNumber);
    const currentMachine = text(stage[0]?.machine);
    if (stage.length > 0 && stage.every((row) => text(row.machine) === desired) || stage.length === 0 && !desired) return;
    if (!productionKey) throw new EngineeringOverrideError("This requirement has no production key; its routing cannot be edited");

    if (stage.some(hasWork)) {
      throw new EngineeringOverrideError(`${operationNumber} (${currentMachine}) has recorded work. Release or undo it before changing this operation.`);
    }
    const preQc = (machine: string | null) => Boolean(machine && !requiresPassedQc(machine));
    if (qcPassed && (preQc(currentMachine) || preQc(desired))) {
      throw new EngineeringOverrideError(`Undo the passed QC review before changing ${operationNumber}`);
    }
    if (activeCam && count(activeCam.claimed_quantity) > 0 && operationStatus(activeCam) !== "Complete") {
      throw new EngineeringOverrideError(`CAM for ${operationNumber} is claimed. Release it before changing this operation.`);
    }
    workflowChanged = true;

    if (!desired) {
      for (const row of stage) row.active_in_routing = false;
      if (activeCam) activeCam.active_in_routing = false;
      return;
    }

    if (stage.length > 0) {
      for (const row of stage) row.machine = desired;
    } else {
      const previous = operations.find((row) => !isCam(row) && row.operation_key === manufacturingKey);
      if (previous) {
        if (hasWork(previous) && text(previous.machine) !== desired) {
          throw new EngineeringOverrideError(`${operationNumber} has recorded work from an earlier ${previous.machine} route and cannot be reused for ${desired}.`);
        }
        Object.assign(previous, { active_in_routing: true, machine: desired });
      } else {
        insertedOperations.push({ id: nextTemporaryId--, operation_key: manufacturingKey, requirement_id: requirementId,
          operation_number: operationNumber, machine: desired, work_type: "Manufacturing", active_in_routing: true,
          status: "Planned", claimed_quantity: 0, completed_quantity: 0, quantity_ledger: "[]" });
      }
    }

    if (!requiresCam(desired)) {
      if (activeCam) activeCam.active_in_routing = false;
      return;
    }
    if (activeCam) {
      if (text(activeCam.machine) === desired) return;
      if (operationStatus(activeCam) === "Complete") {
        throw new EngineeringOverrideError(`CAM for ${operationNumber} was completed for ${activeCam.machine}. Reopen it before switching CNC machines.`);
      }
      activeCam.machine = desired;
      return;
    }
    const previousCam = operations.filter((row) => isCam(row) && row.operation_number === operationNumber)
      .sort((left, right) => Number(text(right.machine) === desired) - Number(text(left.machine) === desired) || right.id - left.id)[0];
    if (previousCam && (!hasWork(previousCam) || text(previousCam.machine) === desired)) {
      Object.assign(previousCam, { active_in_routing: true, machine: desired, ...(hasWork(previousCam) ? {} : { status: "Ready" }) });
    } else {
      insertedOperations.push({ id: nextTemporaryId--, operation_key: camKey, requirement_id: requirementId,
        operation_number: operationNumber, machine: desired, work_type: "CAM", active_in_routing: true,
        status: "Ready", claimed_quantity: 0, completed_quantity: 0, quantity_ledger: "[]" });
    }
  }

  /** Activates (or creates) the requirement's finishing job in `color`. */
  function activateFinishing(color: FinishColor) {
    const existing = finishingRows.find((row) => row.production_key === requirement.production_key) ?? finishingRows[0];
    if (existing) Object.assign(existing, { color, active: true, required_quantity: count(requirement.required_quantity) });
    else insertedFinishing = { id: 0, production_key: requirement.production_key, requirement_id: requirementId,
      color, required_quantity: count(requirement.required_quantity), active: true };
  }

  for (const [field, label, max] of [["material", "Material", MAX_MATERIAL_LENGTH], ["name", "Name", MAX_NAME_LENGTH],
    ["description", "Description", MAX_DESCRIPTION_LENGTH]] as const) {
    const edit = fields[field];
    if (!edit) continue;
    if (!part) throw new EngineeringOverrideError("This requirement is not linked to a part");
    if ("value" in edit && (edit.value ?? "").trim().length > max) {
      throw new EngineeringOverrideError(`${label} must be ${max} characters or fewer`, 400);
    }
    if (field === "name" && "value" in edit && !(edit.value ?? "").trim()) throw new EngineeringOverrideError("Enter a part name", 400);
    const target = decide("parts", field, label, part[field], edit, text);
    if (target !== undefined) part[field] = target;
  }

  if (fields.quantity) {
    if ("value" in fields.quantity && (!Number.isInteger(fields.quantity.value) || fields.quantity.value < 1 || fields.quantity.value > MAX_OVERRIDE_QUANTITY)) {
      throw new EngineeringOverrideError(`Quantity must be a whole number from 1 to ${MAX_OVERRIDE_QUANTITY}`, 400);
    }
    const target = decide("requirements", "required_quantity", "Quantity", requirement.required_quantity, fields.quantity,
      (value) => value === null || value === undefined ? null : Number(value));
    if (target !== undefined && !same(target, requirement.required_quantity)) {
      const quantity = Number(target);
      if (qcPassed && quantity > count(requirement.required_quantity)) {
        throw new EngineeringOverrideError("Undo the passed QC review before increasing the quantity");
      }
      for (const row of activeOperations().filter((candidate) => !isCam(candidate))) {
        const claimed = count(row.claimed_quantity);
        const completed = count(row.completed_quantity);
        if (claimed > 0 && claimed + completed > quantity) {
          throw new EngineeringOverrideError(`${row.operation_number} already has ${claimed + completed} parts claimed or completed. Release claims before reducing the quantity below that.`);
        }
        if (completed >= quantity && operationStatus(row) !== "Complete") {
          row.status = "Complete";
          row.completed_at ??= now;
        } else if (completed < quantity && operationStatus(row) === "Complete") {
          row.status = claimed > 0 ? "In Progress" : "Ready";
          row.completed_at = null;
        }
      }
      requirement.required_quantity = target;
      for (const row of finishingRows) row.required_quantity = quantity;
      workflowChanged = true;
    }
  }

  if (fields.finishing) {
    if ("value" in fields.finishing && !["None", "Red", "Black"].includes(fields.finishing.value)) {
      throw new EngineeringOverrideError("Choose None, Red, or Black", 400);
    }
    const before = normalizeFinishColor(requirement.finishing);
    const target = decide<FinishColor>("requirements", "finishing", "Finishing", requirement.finishing, fields.finishing, normalizeFinishColor);
    if (target !== undefined) {
      const after = normalizeFinishColor(target);
      if (after !== before) {
        const existing = finishingRows.find((row) => row.production_key === requirement.production_key) ?? finishingRows[0];
        if (after !== "None") {
          if (before === "None") {
            if (requirement.part_location === "On Robot") throw new EngineeringOverrideError("Move the part off the robot before adding finishing");
            const postQcStarted = activeOperations().some((row) => !isCam(row) && requiresPassedQc(String(row.machine ?? "")) && hasWork(row));
            if (postQcStarted) throw new EngineeringOverrideError("Threaded-insert work has started. Undo it before adding finishing.");
            finishingNewlyRequired = true;
          }
          activateFinishing(after);
        } else {
          if (existing?.active && text(existing.machinist)) throw new EngineeringOverrideError("Release the finishing claim before removing finishing");
          if (requirement.status === "Ready for Finishing" && requirement.part_location === "On Robot") {
            throw new EngineeringOverrideError("Move the part off the robot before changing finishing");
          }
          for (const row of finishingRows) row.active = false;
        }
        workflowChanged = true;
      }
      requirement.finishing = target;
    }
  }

  if (fields.routing) {
    if ("value" in fields.routing) {
      const error = Array.isArray(fields.routing.value) && fields.routing.value.length === 4 ? routingError(fields.routing.value) : "Provide four operation slots";
      if (error) throw new EngineeringOverrideError(error, 400);
    }
    ROUTING_FIELDS.forEach((field, index) => {
      const target = decide<string | null>("requirements", field, `OP${index + 1}`, requirement[field],
        "revert" in fields.routing! ? { revert: true } : { value: (fields.routing as { value: Routing }).value[index] }, text);
      if (target === undefined) return;
      requirement[field] = target;
      routeStage(index, text(target));
    });
  }

  if (offTheShelfChanged) {
    summary.push({ field: "Off-the-shelf", from: offTheShelfBefore ? "Yes" : "No", to: offTheShelfAfter ? "Yes" : "No" });
    requirement.off_the_shelf = offTheShelfAfter;
    if (offTheShelfAfter) {
      // Buying the part retires its routing and finishing; nothing made so far is discarded.
      for (const row of activeOperations()) {
        if (!isCam(row) && hasWork(row)) {
          throw new EngineeringOverrideError(`${row.operation_number} (${row.machine}) has recorded work. Release or undo it before marking the part off-the-shelf.`);
        }
        if (isCam(row) && count(row.claimed_quantity) > 0 && operationStatus(row) !== "Complete") {
          throw new EngineeringOverrideError(`CAM for ${row.operation_number} is claimed. Release it before marking the part off-the-shelf.`);
        }
      }
      if (finishingRows.some((row) => row.active && text(row.machinist))) {
        throw new EngineeringOverrideError("Release the finishing claim before marking the part off-the-shelf");
      }
      for (const row of activeOperations()) row.active_in_routing = false;
      for (const row of finishingRows) row.active = false;
    } else {
      // Manufacturing resumes from the requirement's current (possibly corrected) routing.
      ROUTING_FIELDS.forEach((field, index) => routeStage(index, text(requirement[field])));
      const color = normalizeFinishColor(requirement.finishing);
      if (color !== "None") activateFinishing(color);
      workflowChanged = true;
    }
  }

  // Off-the-shelf parts have no routing to plan; their shop status is left as it was.
  if (workflowChanged && !requirement.off_the_shelf) {
    const finishingRequired = normalizeFinishColor(requirement.finishing) !== "None";
    const requirementStatus = String(requirement.status ?? "Needs Triage");
    const finishingComplete = finishingNewlyRequired ? false
      : !finishingRequired || qcPassed && !["Ready for QC", "Ready for Finishing"].includes(requirementStatus);
    const active = activeOperations();
    const plan = planRequirementWorkflow(active.map((row) => ({
      id: row.id,
      operationKey: String(row.operation_key ?? row.id),
      operationNumber: String(row.operation_number ?? "OP1"),
      machine: String(row.machine ?? "Unassigned"),
      workType: isCam(row) ? "CAM" : "Manufacturing",
      status: operationStatus(row),
      active: true,
      claimedQuantity: count(row.claimed_quantity),
      completedQuantity: count(row.completed_quantity),
      startedAt: row.started_at as string | null,
      completedAt: row.completed_at as string | null,
    })), requirementStatus, { qcPassed, finishingRequired, finishingComplete });
    for (const patch of plan.operationPatches) {
      const row = active.find((candidate) => candidate.id === patch.id);
      if (row) row.status = patch.status;
    }
    requirement.status = plan.requirementStatus;
    if (plan.requirementStatus === "Ready for QC" && requirement.qc_outcome && requirement.qc_outcome !== "Not Inspected") {
      requirement.qc_outcome = "Not Inspected";
    }
  }

  const changes: OverrideRowChange[] = [];
  function collect(entity: OverrideRowChange["entity"], before: Row | undefined, after: Row) {
    if (!before) return;
    const patch = Object.fromEntries(PATCHABLE[entity].filter((column) => !same(before[column], after[column])).map((column) => [column, after[column] ?? null]));
    if (Object.keys(patch).length) changes.push({ entity, id: after.id, patch });
  }
  collect("requirements", sourceRequirement, requirement);
  if (part) collect("parts", sourcePart, part);
  for (const row of operations) collect("operations", rows.operations?.find((candidate) => candidate.id === row.id), row);
  for (const row of finishingRows) collect("finishing", rows.finishing?.find((candidate) => candidate.id === row.id), row);
  // Assigned inside helpers, so TypeScript cannot narrow it here.
  const finishingInsert = insertedFinishing as Row | null;
  const inserts: OverrideRowInsert[] = [
    ...insertedOperations.map(({ id: _id, ...row }) => { void _id; return { entity: "operations" as const, row }; }),
    ...(finishingInsert ? [{ entity: "finishing" as const, row: (({ id: _id, ...row }) => { void _id; return row; })(finishingInsert) }] : []),
  ];

  return {
    overrides,
    changes,
    inserts,
    summary,
    requirementStatus: String(requirement.status ?? "Needs Triage"),
    previousRequirementStatus: String(sourceRequirement.status ?? "Needs Triage"),
    partName: part && !same(part.name, sourcePart?.name) ? text(part.name) : null,
    /** True when what the shop should make changed: quantity, routing, finishing, or sourcing. */
    routingChanged: changes.some((change) => change.entity === "operations" || change.entity === "finishing"
      || change.entity === "requirements" && ["required_quantity", "off_the_shelf"].some((column) => column in change.patch))
      || inserts.length > 0,
  };
}
