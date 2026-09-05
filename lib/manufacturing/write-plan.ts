// Workflow behavior captured from lib/baserow.ts; all I/O is confined to an in-memory transaction.
import { deduplicateOperations, planRequirementWorkflow, validateCamAction } from '../manufacturing-workflow.ts';
import type { FabricationAction, ManufacturingOperation, OperationAllocation, OperationPatch, OperationQuantityAction, OperationStatus, OperationWorkType, QualityResult } from '../types.ts';
import { ENTITIES, denormalizeRow, normalizeRow, type NormalizedRow, type RawRow } from './model.ts';
type BaserowRow = RawRow;
function canonicalRows(rows: RawRow[]) {
  return deduplicateOperations(rows.filter(row => row["Active in Routing"]).map(row => ({
    id: row.id, operationKey: String(row.Operation ?? ""), workType: operationWorkType(row),
    status: selectValue(row.Status, "Planned") as OperationStatus,
    claimedQuantity: Number(row["Claimed Quantity"] ?? 0), completedQuantity: Number(row["Completed Quantity"] ?? 0),
    startedAt: row["Started At"] as string | null, completedAt: row["Completed At"] as string | null, row,
  }))).map(item => item.row);
}
export interface DisplacedClaimant {
  userId: string;
  name: string;
  quantity: number;
}
export interface StolenOperationContext {
  operationId: number;
  partNumber: string;
  partName: string;
  operationNumber: ManufacturingOperation["operationNumber"];
  workType: OperationWorkType;
}
function selectValue(value: unknown, fallback = ""): string {
  return typeof value === "object" && value !== null && "value" in value
    ? String((value as { value: unknown }).value ?? fallback)
    : fallback;
}
function operationWorkType(row: BaserowRow): OperationWorkType {
  return selectValue(row["Work Type"], "Manufacturing") === "CAM" ? "CAM" : "Manufacturing";
}
function taskQuantityForRow(row: BaserowRow, requiredQuantity: number) {
  return operationWorkType(row) === "CAM" ? 1 : requiredQuantity;
}
function linkedId(value: unknown): number | null {
  return Array.isArray(value) && value[0] && typeof value[0] === "object" && "id" in value[0]
    ? Number((value[0] as { id: unknown }).id)
    : null;
}
function linkedValue(value: unknown): string {
  return Array.isArray(value) && value[0] && typeof value[0] === "object" && "value" in value[0]
    ? String((value[0] as { value: unknown }).value ?? "")
    : "";
}
function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value[0] && typeof value[0] === "object" && "value" in value[0]) {
    return String((value[0] as { value: unknown }).value ?? "").trim();
  }
  return "";
}
function parseRequirement(display: string) {
  const match = display.match(/^(.+?)\s+—\s+(.+?)\s+\[([^\]]+)]$/);
  return {
    partNumber: match?.[1] ?? display.split(" ")[0] ?? "Unknown",
    partName: match?.[2] ?? display,
    assemblyNumber: match?.[3] ?? "Unassigned",
  };
}
function parseQuantityLedger(value: unknown): OperationAllocation[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): OperationAllocation[] => {
      if (!item || typeof item !== "object") return [];
      const allocation = item as Record<string, unknown>;
      const userId = String(allocation.userId ?? "");
      const name = String(allocation.name ?? "");
      const claimed = Math.max(0, Math.floor(Number(allocation.claimed ?? 0)));
      const completed = Math.max(0, Math.floor(Number(allocation.completed ?? 0)));
      return userId && name && (claimed > 0 || completed > 0) ? [{ userId, name, claimed, completed }] : [];
    });
  } catch {
    return [];
  }
}
function quantitiesForRow(row: BaserowRow, requiredQuantity: number, status: OperationStatus) {
  const rawLedger = row["Quantity Ledger"];
  if (typeof rawLedger === "string" && rawLedger.trim()) {
    const ledger: unknown = JSON.parse(rawLedger);
    if (!Array.isArray(ledger) || ledger.some(a => !a || !a.userId || !a.name ||
      !Number.isSafeInteger(a.claimed) || a.claimed < 0 || !Number.isSafeInteger(a.completed) || a.completed < 0)) {
      throw new Error("Invalid existing quantity ledger; reconciliation is required before editing");
    }
  }
  let allocations = parseQuantityLedger(row["Quantity Ledger"]);
  const hasStoredClaimed = row["Claimed Quantity"] !== null && row["Claimed Quantity"] !== undefined && row["Claimed Quantity"] !== "";
  const hasStoredCompleted = row["Completed Quantity"] !== null && row["Completed Quantity"] !== undefined && row["Completed Quantity"] !== "";
  const storedClaimed = Number(row["Claimed Quantity"]);
  const storedCompleted = Number(row["Completed Quantity"]);
  const claimedFallback = hasStoredClaimed && Number.isFinite(storedClaimed)
    ? Math.max(0, Math.floor(storedClaimed))
    : status === "In Progress" ? requiredQuantity : 0;
  const completedFallback = hasStoredCompleted && Number.isFinite(storedCompleted)
    ? Math.max(0, Math.floor(storedCompleted))
    : status === "Complete" ? requiredQuantity : 0;

  if (allocations.length === 0 && (claimedFallback > 0 || completedFallback > 0)) {
    const legacyName = String(row.Machinist ?? "").trim() || "Legacy assignment";
    allocations = [{
      userId: `legacy:${legacyName.toLocaleLowerCase()}`,
      name: legacyName,
      claimed: claimedFallback,
      completed: completedFallback,
    }];
  }

  const claimedQuantity = allocations.reduce((sum, allocation) => sum + allocation.claimed, 0);
  const completedQuantity = allocations.reduce((sum, allocation) => sum + allocation.completed, 0);
  const canClaim = ["Ready", "In Progress", "Needs Rework"].includes(status);
  return {
    allocations,
    claimedQuantity,
    completedQuantity,
    availableQuantity: canClaim ? Math.max(0, requiredQuantity - claimedQuantity - completedQuantity) : 0,
  };
}
function machinistSummary(allocations: OperationAllocation[], requiredQuantity: number) {
  return allocations
    .filter((allocation) => allocation.claimed + allocation.completed > 0)
    .map((allocation) => requiredQuantity > 1
      ? `${allocation.name} (${allocation.claimed + allocation.completed})`
      : allocation.name)
    .join(", ");
}
function fabricationStatus(requirementStatus: string, machinist: string): ManufacturingOperation["status"] {
  if (requirementStatus === "Complete") return "Complete";
  if (requirementStatus === "Needs Rework") return "Needs Rework";
  if (requirementStatus === "Ready for Finishing") return machinist ? "In Progress" : "Ready";
  return "Planned";
}

export function createWritePlan(input: Record<string, NormalizedRow[]>) {
 const rows = Object.fromEntries(ENTITIES.map(entity=>[String(entity.tableId),(input[entity.name]??[]).map(row=>denormalizeRow(entity,structuredClone(row)))]));
 const OPERATIONS_TABLE_ID='1169282', REQUIREMENTS_TABLE_ID='1119642', FINISHING_TABLE_ID='1170619';
 async function getRow(tableId:string,id:number):Promise<RawRow> { const row=rows[tableId]?.find(r=>r.id===id); if(!row) throw new Error('Manufacturing row not found'); return structuredClone(row); }
 async function listAllRows(tableId:string):Promise<RawRow[]> { return structuredClone(rows[tableId]??[]); }
 async function patchRow(tableId:string,id:number,patch:Record<string,unknown>) {
 const row=rows[tableId]?.find(r=>r.id===id); if(!row) throw new Error('Manufacturing row not found');
 const entity=ENTITIES.find(e=>String(e.tableId)===tableId)!;
 for(const [key,value] of Object.entries(patch)) { const column=entity.columns.find(c=>c[1]===key&&c[3]==='shop'); if(!column)throw new Error('Engineering field is not writable'); row[key]=column[2]==='select' && value!==null ? {value}:value; }
 return structuredClone(row);
 }
async function applyFabricationAction(id: number, action: FabricationAction, actor: { name: string }) {
  

  const finishing = await getRow(FINISHING_TABLE_ID, id);
  if (!Boolean(finishing.Active)) throw new Error("This finishing job is no longer active");
  const requirementId = linkedId(finishing["Production Requirement"]);
  if (!requirementId) throw new Error("Finishing job is not linked to a production requirement");
  const requirement = await getRow(REQUIREMENTS_TABLE_ID, requirementId);
  const requirementStatus = selectValue(requirement.Status, "Needs Triage");
  const assignedMachinist = String(finishing.Machinist ?? "").trim();
  const isAssignedActor = assignedMachinist.toLocaleLowerCase() === actor.name.toLocaleLowerCase();

  let nextMachinist = assignedMachinist;
  let nextRequirementStatus = requirementStatus;
  if (action === "claim") {
    if (requirementStatus !== "Ready for Finishing" || assignedMachinist) throw new Error("This finishing job is not available to claim");
    nextMachinist = actor.name;
    await patchRow(FINISHING_TABLE_ID, id, { Machinist: nextMachinist });
  } else if (action === "release") {
    if (requirementStatus !== "Ready for Finishing" || !isAssignedActor) throw new Error("Only the assigned machinist can release this job");
    nextMachinist = "";
    await patchRow(FINISHING_TABLE_ID, id, { Machinist: "" });
  } else if (action === "complete") {
    if (requirementStatus !== "Ready for Finishing" || !isAssignedActor) throw new Error("Claim this finishing job before completing it");
    nextRequirementStatus = "Complete";
    await patchRow(REQUIREMENTS_TABLE_ID, requirementId, { Status: nextRequirementStatus });
  } else {
    if (requirementStatus !== "Complete" || !isAssignedActor) throw new Error("Only the assigned machinist can undo this completion");
    nextRequirementStatus = "Ready for Finishing";
    await patchRow(REQUIREMENTS_TABLE_ID, requirementId, { Status: nextRequirementStatus });
  }

  return {
    id,
    status: fabricationStatus(nextRequirementStatus, nextMachinist),
    requirementStatus: nextRequirementStatus,
    machinist: nextMachinist,
  };
}
async function reconcileRequirementWorkflow(requirementId: number) {
  const [requirement, operationRows] = await Promise.all([
    getRow(REQUIREMENTS_TABLE_ID, requirementId),
    listAllRows(OPERATIONS_TABLE_ID),
  ]);
  const relatedRows = operationRows.filter((row) => linkedId(row["Production Requirement"]) === requirementId);
  const plan = planRequirementWorkflow(relatedRows.map((row) => ({
    id: row.id,
    operationKey: String(row.Operation ?? row.id),
    operationNumber: selectValue(row["Operation Number"], "OP1"),
    machine: selectValue(row.Machine, "Unassigned"),
    workType: operationWorkType(row),
    status: selectValue(row.Status, "Planned") as OperationStatus,
    active: Boolean(row["Active in Routing"]),
    claimedQuantity: Number(row["Claimed Quantity"] ?? 0),
    completedQuantity: Number(row["Completed Quantity"] ?? 0),
    startedAt: row["Started At"] ? String(row["Started At"]) : null,
    completedAt: row["Completed At"] ? String(row["Completed At"]) : null,
  })), selectValue(requirement.Status, "Needs Triage"));

  await Promise.all(plan.operationPatches.map((patch) => patchRow(OPERATIONS_TABLE_ID, patch.id, { Status: patch.status })));
  if (selectValue(requirement.Status, "Needs Triage") !== plan.requirementStatus) {
    await patchRow(REQUIREMENTS_TABLE_ID, requirementId, { Status: plan.requirementStatus });
  }
  return plan;
}
async function patchOperation(id: number, patch: OperationPatch, machinist: string) {
  

  const operation = await getRow(OPERATIONS_TABLE_ID, id);
  const workType = operationWorkType(operation);
  const body: Record<string, unknown> = {};
  if (patch.status) body.Status = patch.status;
  if (patch.machinist !== undefined) body.Machinist = patch.machinist;
  if ((patch.status === "In Progress" || patch.status === "Complete") && patch.machinist === undefined) body.Machinist = machinist;
  if (patch.status === "In Progress") body["Started At"] = new Date().toISOString();
  if (patch.status === "Complete") body["Completed At"] = new Date().toISOString();
  if (patch.status === "Needs Rework" && workType === "Manufacturing") {
    const requirementId = linkedId(operation["Production Requirement"]);
    if (requirementId) {
      const requirement = await getRow(REQUIREMENTS_TABLE_ID, requirementId);
      const requiredQuantity = Math.max(1, Math.floor(Number(requirement["Required Quantity"] ?? 1)));
      const currentStatus = selectValue(operation.Status, "Planned") as OperationStatus;
      const current = quantitiesForRow(operation, requiredQuantity, currentStatus);
      const allocations = current.allocations.map((allocation) => ({
        ...allocation,
        claimed: allocation.claimed + allocation.completed,
        completed: 0,
      }));
      body["Claimed Quantity"] = allocations.reduce((sum, allocation) => sum + allocation.claimed, 0);
      body["Completed Quantity"] = 0;
      body["Quantity Ledger"] = JSON.stringify(allocations);
      body["Completed At"] = null;
    }
  }

  await patchRow(OPERATIONS_TABLE_ID, id, body);

  const requirementId = linkedId(operation["Production Requirement"]);
  if (requirementId) {
    const requirementPatch: Record<string, unknown> = {};
    if (workType === "Manufacturing" && patch.machinist !== undefined) requirementPatch.Machinist = patch.machinist;
    if (workType === "Manufacturing" && (patch.status === "In Progress" || patch.status === "Complete") && patch.machinist === undefined) {
      requirementPatch.Machinist = machinist;
    }
    if (Object.keys(requirementPatch).length > 0) {
      await patchRow(REQUIREMENTS_TABLE_ID, requirementId, requirementPatch);
    }
    const plan = await reconcileRequirementWorkflow(requirementId);
    if (plan.requirementStatus === "Ready for QC") {
      await patchRow(REQUIREMENTS_TABLE_ID, requirementId, { "QC Outcome": "Not Inspected" });
    }
  }
  return body;
}
async function updateCamHandoff(
  id: number,
  patch: { completedBy: string; programPath: string; notes: string },
) {
  const completedBy = patch.completedBy.trim();
  const programPath = patch.programPath.trim();
  const notes = patch.notes.trim();

  if (!completedBy) throw new Error("Enter who completed the CAM");

  

  const operation = await getRow(OPERATIONS_TABLE_ID, id);
  if (operationWorkType(operation) !== "CAM") throw new Error("Only CAM handoffs can be edited");
  const status = selectValue(operation.Status, "Planned") as OperationStatus;
  if (status !== "Complete") throw new Error("Only completed CAM handoffs can be edited");

  const allocations = quantitiesForRow(operation, 1, status).allocations.map((allocation) => allocation.completed > 0
    ? { ...allocation, name: completedBy }
    : allocation);
  await patchRow(OPERATIONS_TABLE_ID, id, {
    Machinist: completedBy,
    "Quantity Ledger": JSON.stringify(allocations),
    "CAM Program Path": programPath,
    "CAM Notes": notes,
  });

  return {
    id,
    machinist: completedBy,
    allocations,
    camProgramPath: programPath || null,
    camNotes: notes,
  };
}
async function applyQuantityAction(
  id: number,
  action: OperationQuantityAction,
  quantity: number,
  actor: { id: string; name: string },
  camHandoff?: { programPath?: string; notes?: string },
) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantity must be a positive whole number");
  

  const operation = await getRow(OPERATIONS_TABLE_ID, id);
  const requirementId = linkedId(operation["Production Requirement"]);
  if (!requirementId) throw new Error("Operation is not linked to a production requirement");
  const requirement = await getRow(REQUIREMENTS_TABLE_ID, requirementId);
  const requiredQuantity = Math.max(1, Math.floor(Number(requirement["Required Quantity"] ?? 1)));
  const workType = operationWorkType(operation);
  const taskQuantity = taskQuantityForRow(operation, requiredQuantity);
  if (workType === "CAM") validateCamAction({ action, quantity });
  const currentStatus = selectValue(operation.Status, "Planned") as OperationStatus;
  const current = quantitiesForRow(operation, taskQuantity, currentStatus);
  const allocations = current.allocations.map((allocation) => ({ ...allocation }));

  if (workType === "CAM" && action === "undo_complete") {
    const operationRows = await listAllRows(OPERATIONS_TABLE_ID);
    const target = operationRows.find((candidate) =>
      linkedId(candidate["Production Requirement"]) === requirementId
      && operationWorkType(candidate) === "Manufacturing"
      && Boolean(candidate["Active in Routing"])
      && selectValue(candidate["Operation Number"], "OP1") === selectValue(operation["Operation Number"], "OP1")
      && (["In Progress", "Complete"].includes(selectValue(candidate.Status, "Planned")) || Boolean(candidate["Started At"])),
    );
    if (target && (
      ["In Progress", "Complete"].includes(selectValue(target.Status, "Planned"))
      || Boolean(target["Started At"])
    )) {
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
    if (!["Ready", "In Progress", "Needs Rework"].includes(currentStatus)) {
      throw new Error("This operation is not available to claim");
    }
    if (quantity > current.availableQuantity) throw new Error(`Only ${current.availableQuantity} part(s) remain available`);
    actorAllocation.claimed += quantity;
  } else if (action === "release") {
    if (quantity > actorAllocation.claimed) throw new Error(`You only have ${actorAllocation.claimed} part(s) claimed`);
    actorAllocation.claimed -= quantity;
  } else if (action === "complete") {
    if (quantity > actorAllocation.claimed) throw new Error(`You only have ${actorAllocation.claimed} claimed part(s) to complete`);
    actorAllocation.claimed -= quantity;
    actorAllocation.completed += quantity;
  } else {
    const qcOutcome = selectValue(requirement["QC Outcome"]);
    if (qcOutcome === "Passed") throw new Error("Undo the passed QC review before reopening completed work");
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
    Status: nextStatus,
    Machinist: summary,
    "Claimed Quantity": claimedQuantity,
    "Completed Quantity": completedQuantity,
    "Quantity Ledger": JSON.stringify(activeAllocations),
    "Completed At": nextStatus === "Complete" ? timestamp : null,
  };
  if (action === "claim" && !operation["Started At"]) operationPatch["Started At"] = timestamp;
  if (workType === "CAM" && action === "complete") {
    if (camHandoff?.programPath !== undefined) {
      operationPatch["CAM Program Path"] = camHandoff.programPath.trim();
    }
    operationPatch["CAM Notes"] = camHandoff?.notes?.trim() ?? "";
  }
  await patchRow(OPERATIONS_TABLE_ID, id, operationPatch);
  if (workType === "Manufacturing") {
    const requirementPatch: Record<string, unknown> = { Machinist: summary };
    if (action === "undo_complete") requirementPatch["QC Outcome"] = "Not Inspected";
    await patchRow(REQUIREMENTS_TABLE_ID, requirementId, requirementPatch);
  }
  await reconcileRequirementWorkflow(requirementId);

  return {
    id,
    status: nextStatus,
    machinist: summary,
    claimedQuantity,
    completedQuantity,
    availableQuantity: Math.max(0, taskQuantity - claimedQuantity - completedQuantity),
    allocations: activeAllocations,
    startedAt: operationPatch["Started At"] ?? operation["Started At"] ?? null,
    completedAt: operationPatch["Completed At"],
    camProgramPath: workType === "CAM" && action === "complete"
      ? camHandoff?.programPath === undefined
        ? textValue(operation["CAM Program Path"]) || null
        : camHandoff.programPath.trim() || null
      : textValue(operation["CAM Program Path"]) || null,
    camNotes: workType === "CAM" && action === "complete"
      ? camHandoff?.notes?.trim() ?? ""
      : textValue(operation["CAM Notes"]),
  };
}
async function stealOperationClaim(
  id: number,
  actor: { id: string; name: string },
) {
  

  const operation = await getRow(OPERATIONS_TABLE_ID, id);
  const requirementId = linkedId(operation["Production Requirement"]);
  if (!requirementId) throw new Error("Operation is not linked to a production requirement");
  const requirement = await getRow(REQUIREMENTS_TABLE_ID, requirementId);
  const requiredQuantity = Math.max(1, Math.floor(Number(requirement["Required Quantity"] ?? 1)));
  const workType = operationWorkType(operation);
  const taskQuantity = taskQuantityForRow(operation, requiredQuantity);
  const currentStatus = selectValue(operation.Status, "Planned") as OperationStatus;
  if (!["Ready", "In Progress", "Needs Rework"].includes(currentStatus)) {
    throw new Error("This production requirement cannot be stolen right now");
  }

  const current = quantitiesForRow(operation, taskQuantity, currentStatus);
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
    Status: "In Progress",
    Machinist: summary,
    "Claimed Quantity": claimedQuantity,
    "Completed Quantity": completedQuantity,
    "Quantity Ledger": JSON.stringify(activeAllocations),
    "Started At": operation["Started At"] ?? timestamp,
    "Completed At": null,
  };
  await patchRow(OPERATIONS_TABLE_ID, id, operationPatch);
  if (workType === "Manufacturing") {
    await patchRow(REQUIREMENTS_TABLE_ID, requirementId, { Machinist: summary });
  }
  await reconcileRequirementWorkflow(requirementId);

  const parsed = parseRequirement(linkedValue(operation["Production Requirement"]));
  const operationNumber = selectValue(operation["Operation Number"], "OP1") as ManufacturingOperation["operationNumber"];
  return {
    updated: {
      id,
      status: "In Progress" as OperationStatus,
      machinist: summary,
      claimedQuantity,
      completedQuantity,
      availableQuantity: Math.max(0, taskQuantity - claimedQuantity - completedQuantity),
      allocations: activeAllocations,
      startedAt: operationPatch["Started At"],
      completedAt: null,
    },
    displaced,
    context: { operationId: id, ...parsed, operationNumber, workType } satisfies StolenOperationContext,
  };
}
async function renameMachinistAllocations(userId: string, oldName: string, newName: string) {
  if (oldName === newName) return;

  const [operationRows, requirementRows] = await Promise.all([
    listAllRows(OPERATIONS_TABLE_ID),
    listAllRows(REQUIREMENTS_TABLE_ID),
  ]);
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));

  await Promise.all(operationRows.map(async (operation) => {
    const requirementId = linkedId(operation["Production Requirement"]);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    const requiredQuantity = Math.max(1, Math.floor(Number(requirement?.["Required Quantity"] ?? 1)));
    const taskQuantity = taskQuantityForRow(operation, requiredQuantity);
    const status = selectValue(operation.Status, "Planned") as OperationStatus;
    const current = quantitiesForRow(operation, taskQuantity, status);
    let changed = false;
    const allocations = current.allocations.map((allocation) => {
      if (allocation.userId === userId || (
        allocation.userId.startsWith("legacy:")
        && allocation.name.toLocaleLowerCase() === oldName.toLocaleLowerCase()
      )) {
        changed = true;
        return { ...allocation, userId, name: newName };
      }
      return allocation;
    });
    if (!changed) return;

    const summary = machinistSummary(allocations, taskQuantity);
    await patchRow(OPERATIONS_TABLE_ID, operation.id, {
      Machinist: summary,
      "Quantity Ledger": JSON.stringify(allocations),
    });
    if (requirementId) await patchRow(REQUIREMENTS_TABLE_ID, requirementId, { Machinist: summary });
  }));

  const finishingRows = await listAllRows(FINISHING_TABLE_ID);
  await Promise.all(finishingRows.map(async (job) => {
    if (String(job.Machinist ?? "").trim().toLocaleLowerCase() !== oldName.toLocaleLowerCase()) return;
    await patchRow(FINISHING_TABLE_ID, job.id, { Machinist: newName });
  }));
}
async function patchRequirementQualityOutcome(
  requirementId: number,
  result: Exclude<QualityResult, "pending">,
  actorName: string,
  notes: string,
  reviewedAt: string,
) {
  

  const [requirement, operationRows] = await Promise.all([
    getRow(REQUIREMENTS_TABLE_ID, requirementId),
    listAllRows(OPERATIONS_TABLE_ID),
  ]);
  const manufacturingRows = canonicalRows(operationRows).filter((row) =>
    linkedId(row["Production Requirement"]) === requirementId
    && operationWorkType(row) === "Manufacturing"
    && Boolean(row["Active in Routing"]),
  );
  if (manufacturingRows.length === 0) throw new Error("Production requirement has no active manufacturing operations");
  if (!manufacturingRows.every((row) => selectValue(row.Status, "Planned") === "Complete")) {
    throw new Error("All manufacturing operations must be complete before QC");
  }

  if (result === "failed") {
    const reworkOperation = [...manufacturingRows].sort((a, b) =>
      selectValue(b["Operation Number"], "OP1").localeCompare(selectValue(a["Operation Number"], "OP1")) || b.id - a.id,
    )[0];
    await patchOperation(reworkOperation.id, { status: "Needs Rework" }, actorName);
  }

  const finishing = selectValue(requirement.Finishing);
  const status = result === "failed"
    ? "Needs Rework"
    : finishing && finishing !== "None"
      ? "Ready for Finishing"
      : "Complete";

  return patchRow(REQUIREMENTS_TABLE_ID, requirementId, {
    "QC Outcome": result === "passed" ? "Passed" : "Failed",
    "QC Notes": notes,
    "QC Reviewed By": actorName,
    "QC Reviewed At": reviewedAt,
    Status: status,
  });
}
async function clearPassedRequirementQualityOutcome(requirementId: number) {
  

  const operationRows = await listAllRows(OPERATIONS_TABLE_ID);
  const manufacturingRows = canonicalRows(operationRows).filter((row) =>
    linkedId(row["Production Requirement"]) === requirementId
    && operationWorkType(row) === "Manufacturing"
    && Boolean(row["Active in Routing"]),
  );
  if (manufacturingRows.length === 0 || !manufacturingRows.every((row) => selectValue(row.Status, "Planned") === "Complete")) {
    throw new Error("Only a passed QC review with all operations complete can be undone");
  }
  await patchRow(REQUIREMENTS_TABLE_ID, requirementId, {
    "QC Outcome": "Not Inspected",
    "QC Notes": "",
    "QC Reviewed By": "",
    "QC Reviewed At": null,
    Status: "Ready for QC",
  });
}
return { applyFabricationAction,patchOperation,updateCamHandoff,applyQuantityAction,stealOperationClaim,renameMachinistAllocations,patchRequirementQualityOutcome,clearPassedRequirementQualityOutcome,
 changes() {
 return ENTITIES.flatMap(entity=>(input[entity.name]??[]).flatMap(before=>{
 const after=normalizeRow(entity,rows[String(entity.tableId)].find(r=>r.id===before.id)!);
 const baseline=normalizeRow(entity,denormalizeRow(entity,before)) as Record<string,unknown>;
 const patch=Object.fromEntries(entity.columns.filter(([column,,,owner])=>owner==='shop'&&JSON.stringify(baseline[column]??null)!==JSON.stringify((after as Record<string,unknown>)[column]??null)).map(([column])=>[column,(after as Record<string,unknown>)[column]??null]));
 if(entity.name==='operations' && 'quantity_ledger' in patch) {
   const ledger=JSON.parse(String(patch.quantity_ledger)) as OperationAllocation[];
   patch.claimed_quantity=ledger.reduce((n,a)=>n+a.claimed,0);
   patch.completed_quantity=ledger.reduce((n,a)=>n+a.completed,0);
 }
 return Object.keys(patch).length?[{entity:entity.name,id:before.id,patch}]:[];
 }));
 }
 };
}
