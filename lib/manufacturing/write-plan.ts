// Manufacturing workflow planning is pure; all I/O is committed by the Supabase transaction adapter.
import { deduplicateOperations, isFinishingComplete, isPostQcOperation, normalizeOperationStatus, planRequirementWorkflow, targetMachineHasStarted, validateCamAction } from "../manufacturing-workflow.ts";
import type { FabricationAction, ManufacturingOperation, OperationAllocation, OperationPatch, OperationQuantityAction, OperationStatus, OperationWorkType, QualityResult } from "../types.ts";
import { SHOP_COLUMNS, shopColumnValue, type NormalizedRow, type ShopEntity } from "./model.ts";
import { notificationPartContext } from "./identity.ts";
import { assertValidLedger, fabricationStatus, linkedId, operationWorkType, quantitiesForRow, selectValue, taskQuantityForRow, textValue } from "./rows.ts";

export interface StolenOperationContext {
  operationId: number;
  requirementId: number;
  partNumber: string;
  partName: string;
  assemblyNumber: string;
  operationNumber: ManufacturingOperation["operationNumber"];
  workType: OperationWorkType;
  machine: string;
  quantity: number;
}

function operationStatus(value: unknown): OperationStatus {
  return normalizeOperationStatus(selectValue(value, "Planned"));
}
function canonicalRows(rows: NormalizedRow[]) {
  return deduplicateOperations(rows.filter(row => row.active_in_routing).map(row => ({
    id: row.id, operationKey: String(row.operation_key ?? ""), workType: operationWorkType(row),
    status: operationStatus(row.status),
    claimedQuantity: Number(row.claimed_quantity ?? 0), completedQuantity: Number(row.completed_quantity ?? 0),
    startedAt: row.started_at as string | null, completedAt: row.completed_at as string | null, row,
  }))).map(item => item.row);
}
/** Like quantitiesForRow, but refuses to edit a ledger that is not valid. */
function ledgerQuantities(row: NormalizedRow, requiredQuantity: number, status: OperationStatus) {
  assertValidLedger(row);
  return quantitiesForRow(row, requiredQuantity, status);
}
function machinistSummary(allocations: OperationAllocation[], requiredQuantity: number) {
  return allocations
    .filter((allocation) => allocation.claimed + allocation.completed > 0)
    .map((allocation) => requiredQuantity > 1
      ? `${allocation.name} (${allocation.claimed + allocation.completed})`
      : allocation.name)
    .join(", ");
}
/** Renames one person's entries in a summary such as "Alex A. (2), Bea B. (1)", keeping each "(n)". */
function renameInSummary(summary: string, names: Iterable<string>, newName: string) {
  const keys = new Set([...names].map((name) => name.trim().toLocaleLowerCase()));
  return summary.split(", ").map((entry) => {
    const [, name, count = ""] = entry.match(/^(.*?)( \(\d+\))?$/) ?? [];
    return name !== undefined && keys.has(name.trim().toLocaleLowerCase()) ? `${newName}${count}` : entry;
  }).join(", ");
}
function operationIndex(value: unknown) {
  const match = selectValue(value, "OP1").match(/^OP(\d+)$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
function subtractCompletedQuantity(allocations: OperationAllocation[], quantity: number) {
  const next = allocations.map((allocation) => ({ ...allocation }));
  let remaining = quantity;
  for (let index = next.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const removed = Math.min(next[index].completed, remaining);
    next[index].completed -= removed;
    remaining -= removed;
  }
  if (remaining > 0) throw new Error("Rejected quantity exceeds completed work");
  return next.filter((allocation) => allocation.claimed > 0 || allocation.completed > 0);
}

/**
 * Plans shop writes against copies of the write-state rows. The adapter checks that the
 * operation, job, or requirement is active and allowed before calling a method.
 */
export function createWritePlan(input: Record<string, NormalizedRow[]>) {
  const rows: Record<ShopEntity, NormalizedRow[]> = {
    requirements: (input.requirements ?? []).map(row => ({ ...row })),
    operations: (input.operations ?? []).map(row => ({ ...row })),
    finishing: (input.finishing ?? []).map(row => ({ ...row })),
  };
  const qcPoints = new Map(rows.requirements.map(row => [row.id, row.qc_after_operation == null ? null : Number(row.qc_after_operation)]));
  function isPostQcOperationRow(row: NormalizedRow) {
    return operationWorkType(row) === "Manufacturing" && isPostQcOperation(
      { machine: selectValue(row.machine), operationNumber: selectValue(row.operation_number, "OP1") },
      qcPoints.get(linkedId(row.requirement_id) ?? -1));
  }
  /** A copy, so callers can still read the values from before their own patches. */
  function getRow(entity: ShopEntity, id: number) {
    const row = rows[entity].find(candidate => candidate.id === id);
    if (!row) throw new Error("Manufacturing row not found");
    return { ...row };
  }
  function listAllRows(entity: ShopEntity) {
    return rows[entity].map(row => ({ ...row }));
  }
  function patchRow(entity: ShopEntity, id: number, patch: Record<string, unknown>) {
    const row = rows[entity].find(candidate => candidate.id === id);
    if (!row) throw new Error("Manufacturing row not found");
    for (const [column, value] of Object.entries(patch)) {
      if (!Object.hasOwn(SHOP_COLUMNS[entity], column)) throw new Error("Engineering field is not writable");
      row[column] = value;
    }
  }

  function applyFabricationAction(id: number, action: FabricationAction, actor: { name: string }) {
    const finishing = getRow("finishing", id);
    const requirementId = linkedId(finishing.requirement_id)!;
    const requirement = getRow("requirements", requirementId);
    const postQcRows = canonicalRows(listAllRows("operations")).filter((row) =>
      linkedId(row.requirement_id) === requirementId && isPostQcOperationRow(row));
    const requirementStatus = selectValue(requirement.status, "Needs Triage");
    const assignedMachinist = String(finishing.machinist ?? "").trim();
    const isAssignedActor = assignedMachinist.toLocaleLowerCase() === actor.name.toLocaleLowerCase();

    let nextMachinist = assignedMachinist;
    let nextRequirementStatus = requirementStatus;
    if (action === "claim") {
      if (requirementStatus !== "Ready for Finishing" || assignedMachinist) throw new Error("This finishing job is not available to claim");
      nextMachinist = actor.name;
      patchRow("finishing", id, { machinist: nextMachinist });
    } else if (action === "steal") {
      if (requirementStatus !== "Ready for Finishing" || !assignedMachinist || isAssignedActor) {
        throw new Error("Only unfinished finishing jobs claimed by someone else can be stolen");
      }
      nextMachinist = actor.name;
      patchRow("finishing", id, { machinist: nextMachinist });
    } else if (action === "release") {
      if (requirementStatus !== "Ready for Finishing" || !isAssignedActor) throw new Error("Only the assigned machinist can release this job");
      nextMachinist = "";
      patchRow("finishing", id, { machinist: "" });
    } else if (action === "complete") {
      if (requirementStatus !== "Ready for Finishing" || !isAssignedActor) throw new Error("Claim this finishing job before completing it");
      nextRequirementStatus = postQcRows.length > 0 ? "Ready for Manufacturing" : "Complete";
      patchRow("requirements", requirementId, { status: nextRequirementStatus });
      if (postQcRows.length > 0) {
        nextRequirementStatus = reconcileRequirementWorkflow(requirementId, { finishingComplete: true }).requirementStatus;
      }
    } else {
      const postQcWorkStarted = postQcRows.some((row) =>
        !["Planned", "Ready"].includes(selectValue(row.status, "Planned"))
        || Number(row.claimed_quantity ?? 0) > 0
        || Number(row.completed_quantity ?? 0) > 0,
      );
      const canUndoCompletedFinishing = postQcRows.length > 0
        ? requirementStatus === "Ready for Manufacturing" && !postQcWorkStarted
        : requirementStatus === "Complete";
      if (!canUndoCompletedFinishing || !isAssignedActor) {
        throw new Error(postQcWorkStarted
          ? "Undo the work after QC before reopening finishing"
          : "Only the assigned machinist can undo this completion");
      }
      nextRequirementStatus = "Ready for Finishing";
      patchRow("requirements", requirementId, { status: nextRequirementStatus });
      if (postQcRows.length > 0) {
        reconcileRequirementWorkflow(requirementId, { finishingComplete: false });
      }
    }

    return {
      id,
      status: action === "complete" ? "Complete" : fabricationStatus(nextRequirementStatus, nextMachinist),
      requirementStatus: nextRequirementStatus,
      machinist: nextMachinist,
      displacedMachinist: action === "steal" ? assignedMachinist : null,
      notificationContext: {
        requirementId,
        ...notificationPartContext(input, requirementId),
        color: selectValue(finishing.color, "Unspecified"),
        quantity: Math.max(1, Math.floor(Number(finishing.required_quantity ?? requirement.required_quantity ?? 1))),
        previousRequirementStatus: requirementStatus,
        requirementStatus: nextRequirementStatus,
      },
    };
  }
  function reconcileRequirementWorkflow(requirementId: number, options: { finishingComplete?: boolean } = {}) {
    const requirement = getRow("requirements", requirementId);
    const relatedRows = listAllRows("operations").filter((row) => linkedId(row.requirement_id) === requirementId);
    const finishing = selectValue(requirement.finishing);
    const finishingRequired = Boolean(finishing && finishing !== "None");
    const requirementStatus = selectValue(requirement.status, "Needs Triage");
    const qcPassed = selectValue(requirement.qc_outcome) === "Passed";
    const finishingComplete = options.finishingComplete ?? isFinishingComplete({ finishingRequired, qcPassed, status: requirementStatus });
    const plan = planRequirementWorkflow(relatedRows.map((row) => ({
      id: row.id,
      operationKey: String(row.operation_key ?? row.id),
      operationNumber: selectValue(row.operation_number, "OP1"),
      machine: selectValue(row.machine, "Unassigned"),
      workType: operationWorkType(row),
      status: operationStatus(row.status),
      active: Boolean(row.active_in_routing),
      claimedQuantity: Number(row.claimed_quantity ?? 0),
      completedQuantity: Number(row.completed_quantity ?? 0),
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
    })), { qcPassed, finishingRequired, finishingComplete, qcAfterOperation: qcPoints.get(requirementId) });

    for (const patch of plan.operationPatches) patchRow("operations", patch.id, { status: patch.status });
    if (requirementStatus !== plan.requirementStatus) {
      patchRow("requirements", requirementId, { status: plan.requirementStatus });
    }
    return plan;
  }
  /** An administrator status override; the adapter refuses In Progress and Complete, which need quantity actions. */
  function patchOperation(id: number, patch: OperationPatch) {
    const operation = getRow("operations", id);
    const workType = operationWorkType(operation);
    const updated: Partial<OperationPatch> = {};
    if (patch.status) updated.status = patch.status;
    if (patch.machinist !== undefined) updated.machinist = patch.machinist;
    patchRow("operations", id, updated);

    const requirementId = linkedId(operation.requirement_id)!;
    const previousRequirementStatus = selectValue(getRow("requirements", requirementId).status, "Needs Triage");
    if (workType === "Manufacturing" && patch.machinist !== undefined) {
      patchRow("requirements", requirementId, { machinist: patch.machinist });
    }
    const { requirementStatus } = reconcileRequirementWorkflow(requirementId);
    if (requirementStatus === "Ready for QC") {
      patchRow("requirements", requirementId, { qc_outcome: "Not Inspected" });
    }
    return {
      ...updated,
      notificationContext: {
        requirementId,
        ...notificationPartContext(input, requirementId),
        operationNumber: selectValue(operation.operation_number, "OP1"),
        workType,
        machine: selectValue(operation.machine, "Unassigned"),
        previousOperationStatus: selectValue(operation.status, "Planned"),
        previousMachinist: String(operation.machinist ?? "").trim(),
        previousRequirementStatus,
        requirementStatus,
      },
    };
  }
  function updateCamHandoff(
    id: number,
    patch: { completedBy: string; programPath: string; notes: string },
  ) {
    const completedBy = patch.completedBy.trim();
    const programPath = patch.programPath.trim();
    const notes = patch.notes.trim();

    if (!completedBy) throw new Error("Enter who completed the CAM");

    const operation = getRow("operations", id);
    if (operationWorkType(operation) !== "CAM") throw new Error("Only CAM handoffs can be edited");
    const status = operationStatus(operation.status);
    if (status !== "Complete") throw new Error("Only completed CAM handoffs can be edited");
    const requirementId = linkedId(operation.requirement_id)!;

    const allocations = ledgerQuantities(operation, 1, status).allocations.map((allocation) => allocation.completed > 0
      ? { ...allocation, name: completedBy }
      : allocation);
    patchRow("operations", id, {
      machinist: completedBy,
      quantity_ledger: JSON.stringify(allocations),
      cam_program_path: programPath,
      cam_notes: notes,
    });

    return {
      id,
      machinist: completedBy,
      allocations,
      camProgramPath: programPath || null,
      camNotes: notes,
      notificationContext: {
        requirementId,
        ...notificationPartContext(input, requirementId),
        operationNumber: selectValue(operation.operation_number, "OP1"),
        machine: selectValue(operation.machine, "Unassigned"),
        previousCompletedBy: String(operation.machinist ?? "").trim(),
        previousProgramPath: textValue(operation.cam_program_path),
        previousNotes: textValue(operation.cam_notes),
      },
    };
  }
  function applyQuantityAction(
    id: number,
    action: OperationQuantityAction,
    quantity: number,
    actor: { id: string; name: string },
    camHandoff?: { programPath?: string; notes?: string; completeAllClaims?: boolean },
  ) {
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantity must be a positive whole number");

    const operation = getRow("operations", id);
    const requirementId = linkedId(operation.requirement_id)!;
    const requirement = getRow("requirements", requirementId);
    const requiredQuantity = Math.max(1, Math.floor(Number(requirement.required_quantity ?? 1)));
    const workType = operationWorkType(operation);
    const postQcOperation = isPostQcOperationRow(operation);
    const qcOutcome = selectValue(requirement.qc_outcome);
    const finishing = selectValue(requirement.finishing);
    const waitingForFinishing = Boolean(finishing && finishing !== "None" && selectValue(requirement.status) === "Ready for Finishing");
    if (postQcOperation && ["claim", "complete"].includes(action) && (qcOutcome !== "Passed" || waitingForFinishing)) {
      throw new Error(waitingForFinishing
        ? "Complete finishing before starting work after QC"
        : "Work after QC requires a passed QC review");
    }
    const taskQuantity = taskQuantityForRow(operation, requiredQuantity);
    if (workType === "CAM") validateCamAction({ action, quantity });
    const currentStatus = operationStatus(operation.status);
    const current = ledgerQuantities(operation, taskQuantity, currentStatus);
    const allocations = current.allocations.map((allocation) => ({ ...allocation }));

    if (workType === "CAM" && action === "undo_complete") {
      const target = listAllRows("operations").find((candidate) =>
        linkedId(candidate.requirement_id) === requirementId
        && operationWorkType(candidate) === "Manufacturing"
        && Boolean(candidate.active_in_routing)
        && selectValue(candidate.operation_number, "OP1") === selectValue(operation.operation_number, "OP1"),
      );
      if (target && targetMachineHasStarted({
        status: operationStatus(target.status),
        claimedQuantity: Number(target.claimed_quantity ?? 0),
        completedQuantity: Number(target.completed_quantity ?? 0),
      })) {
        validateCamAction({ action, quantity, targetStarted: true });
      }
    }

    let actorAllocation = allocations.find((allocation) => allocation.userId === actor.id);
    if (!actorAllocation) {
      actorAllocation = allocations.find((allocation) =>
        allocation.userId.startsWith("legacy:") && allocation.name.toLocaleLowerCase() === actor.name.toLocaleLowerCase(),
      );
      if (actorAllocation) actorAllocation.userId = actor.id;
    }
    if (!actorAllocation) {
      actorAllocation = { userId: actor.id, name: actor.name, claimed: 0, completed: 0 };
      allocations.push(actorAllocation);
    }
    actorAllocation.name = actor.name;

    if (action === "claim") {
      if (!["Ready", "In Progress"].includes(currentStatus)) {
        throw new Error("This operation is not available to claim");
      }
      if (quantity > current.availableQuantity) throw new Error(`Only ${current.availableQuantity} part(s) remain available`);
      actorAllocation.claimed += quantity;
    } else if (action === "release") {
      if (quantity > actorAllocation.claimed) throw new Error(`You only have ${actorAllocation.claimed} part(s) claimed`);
      actorAllocation.claimed -= quantity;
    } else if (action === "complete") {
      if (camHandoff?.completeAllClaims) {
        if (quantity !== current.claimedQuantity) throw new Error("The print claims changed. Refresh before completing them.");
        for (const allocation of allocations) {
          allocation.completed += allocation.claimed;
          allocation.claimed = 0;
        }
      } else {
        if (quantity > actorAllocation.claimed) throw new Error(`You only have ${actorAllocation.claimed} claimed part(s) to complete`);
        actorAllocation.claimed -= quantity;
        actorAllocation.completed += quantity;
      }
    } else {
      if (qcOutcome === "Passed" && !postQcOperation) throw new Error("Undo the passed QC review before reopening completed work");
      if (quantity > actorAllocation.completed) throw new Error(`You only completed ${actorAllocation.completed} part(s)`);
      actorAllocation.completed -= quantity;
      actorAllocation.claimed += quantity;
    }

    const activeAllocations = allocations.filter((allocation) => allocation.claimed > 0 || allocation.completed > 0);
    const claimedQuantity = activeAllocations.reduce((sum, allocation) => sum + allocation.claimed, 0);
    const completedQuantity = activeAllocations.reduce((sum, allocation) => sum + allocation.completed, 0);
    const nextStatus: OperationStatus = completedQuantity >= taskQuantity
      ? "Complete"
      : claimedQuantity > 0
        ? "In Progress"
        : "Ready";
    const timestamp = new Date().toISOString();
    const summary = machinistSummary(activeAllocations, taskQuantity);
    const operationPatch: Record<string, unknown> = {
      status: nextStatus,
      machinist: summary,
      claimed_quantity: claimedQuantity,
      completed_quantity: completedQuantity,
      quantity_ledger: JSON.stringify(activeAllocations),
      completed_at: nextStatus === "Complete" ? timestamp : null,
    };
    if (action === "claim" && !operation.started_at) operationPatch.started_at = timestamp;
    if (action === "release" && claimedQuantity === 0 && completedQuantity === 0) operationPatch.started_at = null;
    if (workType === "CAM" && action === "complete") {
      if (camHandoff?.programPath !== undefined) {
        operationPatch.cam_program_path = camHandoff.programPath.trim();
      }
      operationPatch.cam_notes = camHandoff?.notes?.trim() ?? "";
    }
    patchRow("operations", id, operationPatch);
    if (workType === "Manufacturing") {
      const requirementPatch: Record<string, unknown> = { machinist: summary };
      if (action === "undo_complete" && !postQcOperation) requirementPatch.qc_outcome = "Not Inspected";
      patchRow("requirements", requirementId, requirementPatch);
    }
    const workflow = reconcileRequirementWorkflow(requirementId);

    return {
      id,
      status: nextStatus,
      machinist: summary,
      claimedQuantity,
      completedQuantity,
      availableQuantity: Math.max(0, taskQuantity - claimedQuantity - completedQuantity),
      allocations: activeAllocations,
      startedAt: Object.hasOwn(operationPatch, "started_at")
        ? operationPatch.started_at as string | null
        : operation.started_at ? String(operation.started_at) : null,
      completedAt: operationPatch.completed_at,
      camProgramPath: workType === "CAM" && action === "complete"
        ? camHandoff?.programPath === undefined
          ? textValue(operation.cam_program_path) || null
          : camHandoff.programPath.trim() || null
        : textValue(operation.cam_program_path) || null,
      camNotes: workType === "CAM" && action === "complete"
        ? camHandoff?.notes?.trim() ?? ""
        : textValue(operation.cam_notes),
      notificationContext: {
        requirementId,
        ...notificationPartContext(input, requirementId),
        operationNumber: selectValue(operation.operation_number, "OP1"),
        workType,
        machine: selectValue(operation.machine, "Unassigned"),
        previousRequirementStatus: selectValue(requirement.status, "Needs Triage"),
        requirementStatus: workflow.requirementStatus,
      },
    };
  }
  function stealOperationClaim(
    id: number,
    actor: { id: string; name: string },
  ) {
    const operation = getRow("operations", id);
    const requirementId = linkedId(operation.requirement_id)!;
    const requirement = getRow("requirements", requirementId);
    if (isPostQcOperationRow(operation)) {
      const finishing = selectValue(requirement.finishing);
      if (selectValue(requirement.qc_outcome) !== "Passed") {
        throw new Error("Work after QC requires a passed QC review");
      }
      if (finishing && finishing !== "None" && selectValue(requirement.status) === "Ready for Finishing") {
        throw new Error("Complete finishing before starting work after QC");
      }
    }
    const requiredQuantity = Math.max(1, Math.floor(Number(requirement.required_quantity ?? 1)));
    const workType = operationWorkType(operation);
    const taskQuantity = taskQuantityForRow(operation, requiredQuantity);
    const currentStatus = operationStatus(operation.status);
    if (!["Ready", "In Progress"].includes(currentStatus)) {
      throw new Error("This production requirement cannot be stolen right now");
    }

    const current = ledgerQuantities(operation, taskQuantity, currentStatus);
    if (current.availableQuantity > 0) throw new Error("Claim the remaining available parts instead");
    const allocations = current.allocations.map((allocation) => ({ ...allocation }));
    const legacyActorAllocation = allocations.find((allocation) =>
      allocation.userId.startsWith("legacy:") && allocation.name.toLocaleLowerCase() === actor.name.toLocaleLowerCase(),
    );
    if (legacyActorAllocation) legacyActorAllocation.userId = actor.id;
    const displaced = allocations
      .filter((allocation) => allocation.userId !== actor.id && allocation.claimed > 0)
      .map((allocation) => ({ userId: allocation.userId, name: allocation.name, quantity: allocation.claimed }));
    const stolenQuantity = displaced.reduce((sum, allocation) => sum + allocation.quantity, 0);
    if (stolenQuantity === 0) throw new Error("No one else currently has this production requirement claimed");

    for (const allocation of allocations) {
      if (allocation.userId !== actor.id) allocation.claimed = 0;
    }
    let actorAllocation = allocations.find((allocation) => allocation.userId === actor.id);
    if (!actorAllocation) {
      actorAllocation = { userId: actor.id, name: actor.name, claimed: 0, completed: 0 };
      allocations.push(actorAllocation);
    }
    actorAllocation.name = actor.name;
    actorAllocation.claimed += stolenQuantity;

    const activeAllocations = allocations.filter((allocation) => allocation.claimed > 0 || allocation.completed > 0);
    const claimedQuantity = activeAllocations.reduce((sum, allocation) => sum + allocation.claimed, 0);
    const completedQuantity = activeAllocations.reduce((sum, allocation) => sum + allocation.completed, 0);
    const summary = machinistSummary(activeAllocations, taskQuantity);
    const timestamp = new Date().toISOString();
    const operationPatch = {
      status: "In Progress",
      machinist: summary,
      claimed_quantity: claimedQuantity,
      completed_quantity: completedQuantity,
      quantity_ledger: JSON.stringify(activeAllocations),
      started_at: operation.started_at ?? timestamp,
      completed_at: null,
    };
    patchRow("operations", id, operationPatch);
    if (workType === "Manufacturing") {
      patchRow("requirements", requirementId, { machinist: summary });
    }
    reconcileRequirementWorkflow(requirementId);

    const parsed = notificationPartContext(input, requirementId);
    const operationNumber = selectValue(operation.operation_number, "OP1") as ManufacturingOperation["operationNumber"];
    return {
      updated: {
        id,
        status: "In Progress" as OperationStatus,
        machinist: summary,
        claimedQuantity,
        completedQuantity,
        availableQuantity: Math.max(0, taskQuantity - claimedQuantity - completedQuantity),
        allocations: activeAllocations,
        startedAt: operationPatch.started_at,
        completedAt: null,
      },
      displaced,
      context: {
        operationId: id,
        requirementId,
        ...parsed,
        operationNumber,
        workType,
        machine: selectValue(operation.machine, "Unassigned"),
        quantity: stolenQuantity,
      } satisfies StolenOperationContext,
    };
  }
  function renameMachinistAllocations(userId: string, oldName: string, newName: string) {
    if (oldName === newName) return;
    const frozenRequirements = new Set(rows.requirements.filter(row => row.obsolete).map(row => row.id));
    const requirements = new Map(listAllRows("requirements").map((row) => [row.id, row]));
    const isOldName = (name: string) => name.toLocaleLowerCase() === oldName.toLocaleLowerCase();
    // Other names this account's credits still carried per requirement, e.g. from an earlier rename
    // that skipped the requirement while it was obsolete.
    const earlierNames = new Map<number, Set<string>>();

    const renamed = listAllRows("operations").flatMap((operation) => {
      const requirementId = linkedId(operation.requirement_id);
      if (requirementId && frozenRequirements.has(requirementId)) return [];
      const requirement = requirementId ? requirements.get(requirementId) : undefined;
      const requiredQuantity = Math.max(1, Math.floor(Number(requirement?.required_quantity ?? 1)));
      const taskQuantity = taskQuantityForRow(operation, requiredQuantity);
      const current = ledgerQuantities(operation, taskQuantity, operationStatus(operation.status));
      let changed = false;
      // An admin's "Completed by" correction keeps the account's CAM credit under another name.
      const cam = operationWorkType(operation) === "CAM";
      const allocations = current.allocations.map((allocation) => {
        if (allocation.userId === userId && (!cam || isOldName(allocation.name))
          || allocation.userId.startsWith("legacy:") && isOldName(allocation.name)) {
          changed = true;
          if (requirementId && !isOldName(allocation.name)) {
            earlierNames.set(requirementId, (earlierNames.get(requirementId) ?? new Set()).add(allocation.name));
          }
          return { ...allocation, userId, name: newName };
        }
        return allocation;
      });
      if (!changed) return [];
      return [{ operation, allocations, summary: machinistSummary(allocations, taskQuantity) }];
    });

    for (const { operation, allocations, summary } of renamed) {
      patchRow("operations", operation.id, {
        machinist: summary,
        quantity_ledger: JSON.stringify(allocations),
      });
    }

    // A requirement's assignment names whoever last worked it, possibly from an operation that QC,
    // Force QC or a correction has since rewritten. Rename this person's entries in place rather
    // than copying any operation's summary over it.
    for (const requirement of requirements.values()) {
      if (frozenRequirements.has(requirement.id)) continue;
      const assignment = String(requirement.machinist ?? "");
      const renamedAssignment = renameInSummary(assignment, [oldName, ...(earlierNames.get(requirement.id) ?? [])], newName);
      if (renamedAssignment !== assignment) patchRow("requirements", requirement.id, { machinist: renamedAssignment });
    }

    for (const job of listAllRows("finishing")) {
      if (frozenRequirements.has(linkedId(job.requirement_id) ?? -1)) continue;
      if (String(job.machinist ?? "").trim().toLocaleLowerCase() !== oldName.toLocaleLowerCase()) continue;
      patchRow("finishing", job.id, { machinist: newName });
    }
  }
  /** Records a QC result on the requirement and returns its resulting status. */
  function patchRequirementQualityOutcome(
    requirementId: number,
    result: Exclude<QualityResult, "pending">,
    actorName: string,
    notes: string,
    reviewedAt: string,
    rejectedQuantity?: number,
  ) {
    const requirement = getRow("requirements", requirementId);
    const manufacturingRows = canonicalRows(listAllRows("operations")).filter((row) =>
      linkedId(row.requirement_id) === requirementId && operationWorkType(row) === "Manufacturing");
    const inspectedRows = manufacturingRows.filter((row) => !isPostQcOperationRow(row));
    if (inspectedRows.length === 0) throw new Error("Production requirement has no pre-QC manufacturing operations");
    if (!inspectedRows.every((row) => selectValue(row.status, "Planned") === "Complete")) {
      throw new Error("All pre-QC manufacturing operations must be complete before QC");
    }

    if (result === "failed") {
      const requiredQuantity = Math.max(1, Math.floor(Number(requirement.required_quantity ?? 1)));
      const quantity = rejectedQuantity ?? requiredQuantity;
      // Force QC passes the full required quantity unvalidated, which is non-finite on corrupt rows.
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > requiredQuantity) {
        throw new Error(`Rejected quantity must be a whole number from 1 to ${requiredQuantity}`);
      }
      const firstStage = Math.min(...inspectedRows.map((row) => operationIndex(row.operation_number)));
      for (const row of inspectedRows) {
        const current = ledgerQuantities(row, requiredQuantity, operationStatus(row.status));
        if (current.claimedQuantity !== 0 || current.completedQuantity !== requiredQuantity) {
          throw new Error("The full batch must have completed every pre-QC operation before QC can fail");
        }
        const allocations = subtractCompletedQuantity(current.allocations, quantity);
        const completedQuantity = allocations.reduce((sum, allocation) => sum + allocation.completed, 0);
        patchRow("operations", row.id, {
          status: operationIndex(row.operation_number) === firstStage ? "Ready" : "Planned",
          machinist: machinistSummary(allocations, requiredQuantity),
          claimed_quantity: 0,
          completed_quantity: completedQuantity,
          quantity_ledger: JSON.stringify(allocations),
          completed_at: null,
        });
      }
    }

    const finishing = selectValue(requirement.finishing);
    const hasPostQcWork = manufacturingRows.some(isPostQcOperationRow);
    const status = result === "failed"
      ? "Ready for Manufacturing"
      : finishing && finishing !== "None"
        ? "Ready for Finishing"
        : hasPostQcWork
          ? "Ready for Manufacturing"
          : "Complete";

    patchRow("requirements", requirementId, {
      qc_outcome: result === "passed" ? "Passed" : "Failed",
      qc_notes: notes,
      qc_reviewed_by: actorName,
      qc_reviewed_at: reviewedAt,
      status,
    });
    if (result === "passed" && hasPostQcWork) {
      reconcileRequirementWorkflow(requirementId, { finishingComplete: !finishing || finishing === "None" });
    }
    return selectValue(getRow("requirements", requirementId).status, "Needs Triage");
  }
  function patchRequirementQualityNote(
    requirementId: number,
    actorName: string,
    notes: string,
    reviewedAt: string,
  ) {
    patchRow("requirements", requirementId, {
      qc_notes: notes,
      qc_reviewed_by: actorName,
      qc_reviewed_at: reviewedAt,
    });
  }
  function clearPassedRequirementQualityOutcome(requirementId: number) {
    const manufacturingRows = canonicalRows(listAllRows("operations")).filter((row) =>
      linkedId(row.requirement_id) === requirementId && operationWorkType(row) === "Manufacturing");
    const inspectedRows = manufacturingRows.filter((row) => !isPostQcOperationRow(row));
    const postQcRows = manufacturingRows.filter(isPostQcOperationRow);
    if (inspectedRows.length === 0 || !inspectedRows.every((row) => selectValue(row.status, "Planned") === "Complete")) {
      throw new Error("Only a passed QC review with all pre-QC operations complete can be undone");
    }
    if (postQcRows.some((row) => !["Planned", "Ready"].includes(selectValue(row.status, "Planned"))
      || Number(row.claimed_quantity ?? 0) > 0 || Number(row.completed_quantity ?? 0) > 0)) {
      throw new Error("Undo the work after QC before undoing the QC pass");
    }
    const requirement = getRow("requirements", requirementId);
    const finishing = selectValue(requirement.finishing);
    if (finishing && finishing !== "None" && selectValue(requirement.status) !== "Ready for Finishing") {
      throw new Error("QC cannot be undone after finishing is complete");
    }
    patchRow("requirements", requirementId, {
      qc_outcome: "Not Inspected",
      qc_notes: "",
      qc_reviewed_by: "",
      qc_reviewed_at: null,
      status: "Ready for QC",
    });
    reconcileRequirementWorkflow(requirementId, { finishingComplete: false });
  }
  function previewForceQuality(requirementId: number) {
    const requirement = getRow("requirements", requirementId);
    const active = canonicalRows(listAllRows("operations")).filter(row => linkedId(row.requirement_id) === requirementId);
    const manufacturing = active.filter(row => operationWorkType(row) === "Manufacturing" && !isPostQcOperationRow(row));
    if (!manufacturing.length) throw new Error("Production requirement has no pre-QC manufacturing operations");
    const quantity = Math.max(1, Math.floor(Number(requirement.required_quantity ?? 1)));
    const numbers = new Set(manufacturing.map(row => selectValue(row.operation_number)));
    const affected = active.filter(row => manufacturing.includes(row) || operationWorkType(row) === "CAM" && numbers.has(selectValue(row.operation_number)))
      .filter(row => selectValue(row.status) !== "Complete");
    if (!affected.length) throw new Error("All prerequisite work is already complete; use normal QC");
    const operations = affected.map(row => {
      const status = operationStatus(row.status);
      const total = taskQuantityForRow(row, quantity);
      const current = ledgerQuantities(row, total, status);
      if (current.completedQuantity > total) throw new Error("Completed quantity exceeds the requirement quantity");
      return { id: row.id, operationNumber: selectValue(row.operation_number), workType: operationWorkType(row), machine: selectValue(row.machine), previousStatus: status, quantity: total - current.completedQuantity };
    }).sort((a, b) => a.operationNumber.localeCompare(b.operationNumber) || a.workType.localeCompare(b.workType) || a.id - b.id);
    const finishing = selectValue(requirement.finishing);
    const nextDestination = finishing && finishing !== "None" ? "Finishing" : active.some(isPostQcOperationRow) ? "Post-QC manufacturing" : "Complete";
    const generatedNotes = "Admin Force QC — force-completed prerequisite work:\n" + operations.map(op => `${op.operationNumber} ${op.workType} (${op.machine || "CAM"}): ${op.previousStatus} → Complete; ${op.quantity} ${op.workType === "CAM" ? "task(s)" : "part(s)"} force-completed.`).join("\n");
    return { requirementId, productionKey: String(requirement.production_key ?? ""), quantity, operations, generatedNotes, nextDestination };
  }
  /** Admin Force QC can also finish powder coating, crediting the admin. Null when no finishing is pending. */
  function forceCompleteFinishing(requirementId: number, actor: { name: string }) {
    const requirement = getRow("requirements", requirementId);
    if (selectValue(requirement.status) !== "Ready for Finishing") return null;
    const job = listAllRows("finishing").find(row => Boolean(row.active) && linkedId(row.requirement_id) === requirementId);
    if (!job) throw new Error("This production requirement has no active finishing job");
    patchRow("finishing", job.id, { machinist: actor.name });
    return applyFabricationAction(job.id, "complete", actor);
  }
  function forceCompletePrerequisites(requirementId: number, actor: { id: string; name: string }, timestamp: string) {
    const preview = previewForceQuality(requirementId);
    for (const item of preview.operations) {
      const row = getRow("operations", item.id);
      const total = taskQuantityForRow(row, preview.quantity);
      const allocations = ledgerQuantities(row, total, item.previousStatus).allocations.map(allocation => ({ ...allocation, claimed: 0 }));
      let credit = allocations.find(allocation => allocation.userId === actor.id);
      if (!credit) { credit = { userId: actor.id, name: actor.name, claimed: 0, completed: 0 }; allocations.push(credit); }
      credit.name = actor.name;
      credit.completed += item.quantity;
      const ledger = allocations.filter(allocation => allocation.completed > 0);
      patchRow("operations", item.id, {
        status: "Complete", completed_at: timestamp, claimed_quantity: 0, completed_quantity: total,
        quantity_ledger: JSON.stringify(ledger), machinist: machinistSummary(ledger, total),
      });
    }
    return preview;
  }
  return {
    previewForceQuality, forceCompletePrerequisites, forceCompleteFinishing, applyFabricationAction, patchOperation, updateCamHandoff,
    applyQuantityAction, stealOperationClaim, renameMachinistAllocations, patchRequirementQualityOutcome, patchRequirementQualityNote,
    clearPassedRequirementQualityOutcome,
    /** Per-row patches of the shop columns that differ from the write state. */
    changes() {
      return (Object.keys(SHOP_COLUMNS) as ShopEntity[]).flatMap(entity => (input[entity] ?? []).flatMap(before => {
        const after = rows[entity].find(row => row.id === before.id)!;
        const patch: Record<string, unknown> = {};
        for (const [column, kind] of Object.entries(SHOP_COLUMNS[entity])) {
          const value = shopColumnValue(after[column], kind);
          if (JSON.stringify(shopColumnValue(before[column], kind)) !== JSON.stringify(value)) patch[column] = value;
        }
        if (entity === "operations" && "quantity_ledger" in patch) {
          const ledger = JSON.parse(String(patch.quantity_ledger)) as OperationAllocation[];
          patch.claimed_quantity = ledger.reduce((n, a) => n + a.claimed, 0);
          patch.completed_quantity = ledger.reduce((n, a) => n + a.completed, 0);
        }
        return Object.keys(patch).length ? [{ entity, id: before.id, patch }] : [];
      }));
    },
  };
}
