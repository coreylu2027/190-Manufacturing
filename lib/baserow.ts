import "server-only";

import { DEMO_FABRICATION_JOBS, DEMO_OPERATIONS } from "@/lib/demo-data";
import type {
  FabricationAction,
  FabricationJob,
  ManufacturingOperation,
  OperationAllocation,
  OperationPatch,
  OperationQuantityAction,
  OperationStatus,
  QualityResult,
} from "@/lib/types";

type BaserowRow = Record<string, unknown> & { id: number };

const OPERATIONS_TABLE_ID = process.env.BASEROW_OPERATIONS_TABLE_ID ?? "1169282";
const REQUIREMENTS_TABLE_ID = process.env.BASEROW_REQUIREMENTS_TABLE_ID ?? "1119642";
const PARTS_TABLE_ID = process.env.BASEROW_PARTS_TABLE_ID ?? "1119641";
const FINISHING_TABLE_ID = process.env.BASEROW_FINISHING_TABLE_ID ?? "1170619";
const API_URL = (process.env.BASEROW_API_URL ?? "https://api.baserow.io").replace(/\/$/, "");
const DEMO_STATE = new Map(DEMO_OPERATIONS.map((operation) => [operation.id, {
  ...operation,
  allocations: operation.allocations.map((allocation) => ({ ...allocation })),
}]));
const DEMO_FABRICATION_STATE = new Map(DEMO_FABRICATION_JOBS.map((job) => [job.id, { ...job }]));

export function hasBaserowCredentials() {
  return Boolean(process.env.BASEROW_API_TOKEN);
}

async function baserowFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${process.env.BASEROW_API_TOKEN}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Baserow request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

async function listAllRows(tableId: string): Promise<BaserowRow[]> {
  const first = await baserowFetch(`/api/database/rows/table/${tableId}/?user_field_names=true&size=200&page=1`);
  const rows = [...first.results] as BaserowRow[];
  const pages = Math.ceil(first.count / 200);
  for (let page = 2; page <= pages; page += 1) {
    const next = await baserowFetch(`/api/database/rows/table/${tableId}/?user_field_names=true&size=200&page=${page}`);
    rows.push(...next.results);
  }
  return rows;
}

async function getRow(tableId: string, id: number): Promise<BaserowRow> {
  return baserowFetch(`/api/database/rows/table/${tableId}/${id}/?user_field_names=true`);
}

async function patchRow(tableId: string, id: number, body: Record<string, unknown>) {
  return baserowFetch(`/api/database/rows/table/${tableId}/${id}/?user_field_names=true`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function selectValue(value: unknown, fallback = ""): string {
  return typeof value === "object" && value !== null && "value" in value
    ? String((value as { value: unknown }).value ?? fallback)
    : fallback;
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

function firstFile(value: unknown): { url: string; name: string } | null {
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== "object" || !("url" in value[0])) return null;

  const file = value[0] as Record<string, unknown>;
  const name = file.visible_name ?? file.original_name ?? file.name;
  if (!file.url || !name) return null;
  return { url: String(file.url), name: String(name) };
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value[0] && typeof value[0] === "object" && "value" in value[0]) {
    return String((value[0] as { value: unknown }).value ?? "").trim();
  }
  return "";
}

function sourceDocumentName(requirement: BaserowRow | undefined): string | null {
  if (!requirement) return null;
  return textValue(requirement["Source Document"])
    || textValue(requirement["Onshape Document"])
    || null;
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

export async function getFabricationJobs(): Promise<{ jobs: FabricationJob[]; source: "baserow" | "demo" }> {
  if (!hasBaserowCredentials()) return { jobs: [...DEMO_FABRICATION_STATE.values()], source: "demo" };

  const [finishingRows, requirementRows] = await Promise.all([
    listAllRows(FINISHING_TABLE_ID),
    listAllRows(REQUIREMENTS_TABLE_ID),
  ]);
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));

  const jobs = finishingRows.flatMap((row): FabricationJob[] => {
    const requirementId = linkedId(row["Production Requirement"]);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    if (!requirementId || !requirement) return [];

    const parsed = parseRequirement(linkedValue(row["Production Requirement"]));
    const machinist = String(row.Machinist ?? "").trim();
    const requirementStatus = selectValue(requirement.Status, "Needs Triage");
    const drawingPdf = firstFile(requirement["Drawing PDF"]);
    const stepFile = firstFile(requirement["STEP File"]);
    return [{
      id: row.id,
      productionKey: String(row["Production Key"] ?? row.id),
      requirementId,
      ...parsed,
      documentName: sourceDocumentName(requirement),
      quantity: Math.max(1, Math.floor(Number(row["Required Quantity"] ?? requirement["Required Quantity"] ?? 1))),
      color: selectValue(row["Powder Coat Color"], selectValue(requirement.Finishing, "Unspecified")),
      status: fabricationStatus(requirementStatus, machinist),
      requirementStatus,
      machinist,
      active: Boolean(row.Active),
      lastSyncedAt: row["Last Synced At"] ? String(row["Last Synced At"]) : null,
      drawingUrl: linkedValue(requirement.Drawing) || null,
      drawingPdfUrl: drawingPdf?.url ?? null,
      drawingPdfName: drawingPdf?.name ?? null,
      stepUrl: stepFile?.url ?? null,
      stepName: stepFile?.name ?? null,
      onshapeUrl: requirement["Onshape Source"] ? String(requirement["Onshape Source"]) : null,
    }];
  });

  return { jobs: jobs.filter((job) => job.active), source: "baserow" };
}

export async function applyFabricationAction(id: number, action: FabricationAction, actor: { name: string }) {
  if (!hasBaserowCredentials()) {
    const job = DEMO_FABRICATION_STATE.get(id);
    if (!job) throw new Error("Finishing job not found");
    if (action === "claim") {
      if (job.status !== "Ready") throw new Error("This finishing job is not available to claim");
      job.machinist = actor.name;
      job.status = "In Progress";
    } else if (action === "release") {
      if (job.machinist.toLocaleLowerCase() !== actor.name.toLocaleLowerCase()) throw new Error("Only the assigned machinist can release this job");
      job.machinist = "";
      job.status = "Ready";
    } else if (action === "complete") {
      if (job.status !== "In Progress" || job.machinist.toLocaleLowerCase() !== actor.name.toLocaleLowerCase()) throw new Error("Claim this finishing job before completing it");
      job.status = "Complete";
      job.requirementStatus = "Complete";
    } else {
      if (job.status !== "Complete" || job.machinist.toLocaleLowerCase() !== actor.name.toLocaleLowerCase()) throw new Error("Only the assigned machinist can undo this completion");
      job.status = "In Progress";
      job.requirementStatus = "Ready for Finishing";
    }
    DEMO_FABRICATION_STATE.set(id, { ...job });
    return { id, status: job.status, requirementStatus: job.requirementStatus, machinist: job.machinist };
  }

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

export async function getOperations(): Promise<{ operations: ManufacturingOperation[]; source: "baserow" | "demo" }> {
  if (!hasBaserowCredentials()) return { operations: [...DEMO_STATE.values()], source: "demo" };

  const [operationRows, requirementRows, partRows] = await Promise.all([
    listAllRows(OPERATIONS_TABLE_ID),
    listAllRows(REQUIREMENTS_TABLE_ID),
    listAllRows(PARTS_TABLE_ID),
  ]);
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));
  const parts = new Map(partRows.map((row) => [row.id, row]));

  const operations = operationRows.map((row): ManufacturingOperation => {
    const requirementId = linkedId(row["Production Requirement"]);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    const partId = linkedId(requirement?.Part);
    const part = partId ? parts.get(partId) : undefined;
    const parsed = parseRequirement(linkedValue(row["Production Requirement"]));
    const operationNumber = selectValue(row["Operation Number"], "OP1") as ManufacturingOperation["operationNumber"];
    const status = selectValue(row.Status, "Planned") as OperationStatus;
    const quantity = Number(requirement?.["Required Quantity"] ?? 1);
    const quantities = quantitiesForRow(row, quantity, status);
    const drawingPdf = firstFile(requirement?.["Drawing PDF"]);
    const stepFile = firstFile(requirement?.["STEP File"]);
    return {
      id: row.id,
      operationKey: String(row.Operation ?? `${row.id}`),
      ...parsed,
      documentName: sourceDocumentName(requirement),
      material: textValue(part?.Material) || null,
      quantity,
      ...quantities,
      operationNumber,
      machine: selectValue(row.Machine, "Unassigned"),
      status,
      machinist: String(row.Machinist ?? ""),
      startedAt: row["Started At"] ? String(row["Started At"]) : null,
      completedAt: row["Completed At"] ? String(row["Completed At"]) : null,
      activeInRouting: Boolean(row["Active in Routing"]),
      drawingUrl: linkedValue(requirement?.Drawing) || null,
      drawingPdfUrl: drawingPdf?.url ?? null,
      drawingPdfName: drawingPdf?.name ?? null,
      stepUrl: stepFile?.url ?? null,
      stepName: stepFile?.name ?? null,
      onshapeUrl: requirement?.["Onshape Source"] ? String(requirement["Onshape Source"]) : null,
    };
  });

  return { operations: operations.filter((operation) => operation.activeInRouting), source: "baserow" };
}

export async function patchOperation(id: number, patch: OperationPatch, machinist: string) {
  if (!hasBaserowCredentials()) {
    const operation = DEMO_STATE.get(id);
    if (!operation) throw new Error("Operation not found");
    const timestamp = new Date().toISOString();
    const updated = {
      ...operation,
      ...patch,
      machinist: patch.machinist ?? (patch.status === "In Progress" || patch.status === "Complete" ? machinist : operation.machinist),
      startedAt: patch.status === "In Progress" && !operation.startedAt ? timestamp : operation.startedAt,
      completedAt: patch.status === "Complete" ? timestamp : operation.completedAt,
    };
    DEMO_STATE.set(id, updated);
    return updated;
  }

  const operation = await getRow(OPERATIONS_TABLE_ID, id);
  const body: Record<string, unknown> = {};
  if (patch.status) body.Status = patch.status;
  if (patch.machinist !== undefined) body.Machinist = patch.machinist;
  if ((patch.status === "In Progress" || patch.status === "Complete") && patch.machinist === undefined) body.Machinist = machinist;
  if (patch.status === "In Progress") body["Started At"] = new Date().toISOString();
  if (patch.status === "Complete") body["Completed At"] = new Date().toISOString();
  if (patch.status === "Needs Rework") {
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
    if (patch.machinist !== undefined) requirementPatch.Machinist = patch.machinist;
    if ((patch.status === "In Progress" || patch.status === "Complete") && patch.machinist === undefined) {
      requirementPatch.Machinist = machinist;
    }

    if (patch.status === "In Progress") {
      requirementPatch.Status = "On Machine";
    } else if (patch.status === "Needs Rework") {
      requirementPatch.Status = "Needs Rework";
    } else if (patch.status === "Complete") {
      const operations = await listAllRows(OPERATIONS_TABLE_ID);
      const relatedActiveOperations = operations.filter((row) =>
        linkedId(row["Production Requirement"]) === requirementId && Boolean(row["Active in Routing"]),
      );
      const allOperationsComplete = relatedActiveOperations.every((row) =>
        row.id === id || selectValue(row.Status, "Planned") === "Complete",
      );
      requirementPatch.Status = allOperationsComplete ? "Ready for QC" : "On Machine";
      if (allOperationsComplete) requirementPatch["QC Outcome"] = "Not Inspected";
    }

    if (Object.keys(requirementPatch).length > 0) {
      await patchRow(REQUIREMENTS_TABLE_ID, requirementId, requirementPatch);
    }
  }
  return body;
}

export async function applyQuantityAction(
  id: number,
  action: OperationQuantityAction,
  quantity: number,
  actor: { id: string; name: string },
) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantity must be a positive whole number");
  if (!hasBaserowCredentials()) {
    const operation = DEMO_STATE.get(id);
    if (!operation) throw new Error("Operation not found");
    const allocations = operation.allocations.map((allocation) => ({ ...allocation }));
    let actorAllocation = allocations.find((allocation) => allocation.userId === actor.id);
    if (!actorAllocation) {
      actorAllocation = { userId: actor.id, name: actor.name, claimed: 0, completed: 0 };
      allocations.push(actorAllocation);
    }
    if (action === "claim") {
      if (quantity > operation.availableQuantity) throw new Error(`Only ${operation.availableQuantity} part(s) remain available`);
      actorAllocation.claimed += quantity;
    } else if (action === "release") {
      if (quantity > actorAllocation.claimed) throw new Error(`You only have ${actorAllocation.claimed} part(s) claimed`);
      actorAllocation.claimed -= quantity;
    } else if (action === "complete") {
      if (quantity > actorAllocation.claimed) throw new Error(`You only have ${actorAllocation.claimed} claimed part(s) to complete`);
      actorAllocation.claimed -= quantity;
      actorAllocation.completed += quantity;
    } else {
      if (quantity > actorAllocation.completed) throw new Error(`You only completed ${actorAllocation.completed} part(s)`);
      actorAllocation.completed -= quantity;
      actorAllocation.claimed += quantity;
    }
    const activeAllocations = allocations.filter((allocation) => allocation.claimed > 0 || allocation.completed > 0);
    const claimedQuantity = activeAllocations.reduce((sum, allocation) => sum + allocation.claimed, 0);
    const completedQuantity = activeAllocations.reduce((sum, allocation) => sum + allocation.completed, 0);
    const status: OperationStatus = completedQuantity >= operation.quantity ? "Complete" : claimedQuantity > 0 ? "In Progress" : "Ready";
    const timestamp = new Date().toISOString();
    const updated = {
      id,
      status,
      machinist: machinistSummary(activeAllocations, operation.quantity),
      claimedQuantity,
      completedQuantity,
      availableQuantity: Math.max(0, operation.quantity - claimedQuantity - completedQuantity),
      allocations: activeAllocations,
      startedAt: action === "claim" && !operation.startedAt ? timestamp : operation.startedAt,
      completedAt: status === "Complete" ? timestamp : null,
    };
    DEMO_STATE.set(id, { ...operation, ...updated });
    return updated;
  }

  const operation = await getRow(OPERATIONS_TABLE_ID, id);
  const requirementId = linkedId(operation["Production Requirement"]);
  if (!requirementId) throw new Error("Operation is not linked to a production requirement");
  const requirement = await getRow(REQUIREMENTS_TABLE_ID, requirementId);
  const requiredQuantity = Math.max(1, Math.floor(Number(requirement["Required Quantity"] ?? 1)));
  const currentStatus = selectValue(operation.Status, "Planned") as OperationStatus;
  const current = quantitiesForRow(operation, requiredQuantity, currentStatus);
  const allocations = current.allocations.map((allocation) => ({ ...allocation }));

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
  const nextStatus: OperationStatus = completedQuantity >= requiredQuantity
    ? "Complete"
    : claimedQuantity > 0
      ? "In Progress"
      : "Ready";
  const timestamp = new Date().toISOString();
  const summary = machinistSummary(activeAllocations, requiredQuantity);
  const operationPatch: Record<string, unknown> = {
    Status: nextStatus,
    Machinist: summary,
    "Claimed Quantity": claimedQuantity,
    "Completed Quantity": completedQuantity,
    "Quantity Ledger": JSON.stringify(activeAllocations),
    "Completed At": nextStatus === "Complete" ? timestamp : null,
  };
  if (action === "claim" && !operation["Started At"]) operationPatch["Started At"] = timestamp;
  await patchRow(OPERATIONS_TABLE_ID, id, operationPatch);

  const operationRows = await listAllRows(OPERATIONS_TABLE_ID);
  const relatedActiveOperations = operationRows.filter((row) =>
    linkedId(row["Production Requirement"]) === requirementId && Boolean(row["Active in Routing"]),
  );
  const allOperationsComplete = relatedActiveOperations.every((row) =>
    row.id === id ? nextStatus === "Complete" : selectValue(row.Status, "Planned") === "Complete",
  );
  const requirementPatch: Record<string, unknown> = { Machinist: summary };
  if (allOperationsComplete) {
    requirementPatch.Status = "Ready for QC";
    requirementPatch["QC Outcome"] = "Not Inspected";
  } else if (claimedQuantity > 0 || completedQuantity > 0) {
    requirementPatch.Status = "On Machine";
    if (action === "undo_complete") requirementPatch["QC Outcome"] = "Not Inspected";
  } else {
    requirementPatch.Status = "Ready for Manufacturing";
  }
  await patchRow(REQUIREMENTS_TABLE_ID, requirementId, requirementPatch);

  return {
    id,
    status: nextStatus,
    machinist: summary,
    claimedQuantity,
    completedQuantity,
    availableQuantity: Math.max(0, requiredQuantity - claimedQuantity - completedQuantity),
    allocations: activeAllocations,
    startedAt: operationPatch["Started At"] ?? operation["Started At"] ?? null,
    completedAt: operationPatch["Completed At"],
  };
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
}

export async function stealOperationClaim(
  id: number,
  actor: { id: string; name: string },
) {
  if (!hasBaserowCredentials()) {
    const operation = DEMO_STATE.get(id);
    if (!operation) throw new Error("Operation not found");
    if (!["Ready", "In Progress", "Needs Rework"].includes(operation.status)) {
      throw new Error("This production requirement cannot be stolen right now");
    }
    if (operation.availableQuantity > 0) throw new Error("Claim the remaining available parts instead");

    const allocations = operation.allocations.map((allocation) => ({ ...allocation }));
    const namedActorAllocation = allocations.find((allocation) =>
      allocation.userId !== actor.id && allocation.name.toLocaleLowerCase() === actor.name.toLocaleLowerCase(),
    );
    if (namedActorAllocation) namedActorAllocation.userId = actor.id;
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
    const updated = {
      id,
      status: "In Progress" as OperationStatus,
      machinist: machinistSummary(activeAllocations, operation.quantity),
      claimedQuantity: activeAllocations.reduce((sum, allocation) => sum + allocation.claimed, 0),
      completedQuantity: activeAllocations.reduce((sum, allocation) => sum + allocation.completed, 0),
      availableQuantity: 0,
      allocations: activeAllocations,
      startedAt: operation.startedAt ?? new Date().toISOString(),
      completedAt: null,
    };
    DEMO_STATE.set(id, { ...operation, ...updated });
    return {
      updated,
      displaced,
      context: {
        operationId: id,
        partNumber: operation.partNumber,
        partName: operation.partName,
        operationNumber: operation.operationNumber,
      } satisfies StolenOperationContext,
    };
  }

  const operation = await getRow(OPERATIONS_TABLE_ID, id);
  const requirementId = linkedId(operation["Production Requirement"]);
  if (!requirementId) throw new Error("Operation is not linked to a production requirement");
  const requirement = await getRow(REQUIREMENTS_TABLE_ID, requirementId);
  const requiredQuantity = Math.max(1, Math.floor(Number(requirement["Required Quantity"] ?? 1)));
  const currentStatus = selectValue(operation.Status, "Planned") as OperationStatus;
  if (!["Ready", "In Progress", "Needs Rework"].includes(currentStatus)) {
    throw new Error("This production requirement cannot be stolen right now");
  }

  const current = quantitiesForRow(operation, requiredQuantity, currentStatus);
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
  const summary = machinistSummary(activeAllocations, requiredQuantity);
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
  await patchRow(REQUIREMENTS_TABLE_ID, requirementId, { Status: "On Machine", Machinist: summary });

  const parsed = parseRequirement(linkedValue(operation["Production Requirement"]));
  const operationNumber = selectValue(operation["Operation Number"], "OP1") as ManufacturingOperation["operationNumber"];
  return {
    updated: {
      id,
      status: "In Progress" as OperationStatus,
      machinist: summary,
      claimedQuantity,
      completedQuantity,
      availableQuantity: Math.max(0, requiredQuantity - claimedQuantity - completedQuantity),
      allocations: activeAllocations,
      startedAt: operationPatch["Started At"],
      completedAt: null,
    },
    displaced,
    context: { operationId: id, ...parsed, operationNumber } satisfies StolenOperationContext,
  };
}

export async function renameMachinistAllocations(userId: string, oldName: string, newName: string) {
  if (!hasBaserowCredentials() || oldName === newName) return;

  const [operationRows, requirementRows] = await Promise.all([
    listAllRows(OPERATIONS_TABLE_ID),
    listAllRows(REQUIREMENTS_TABLE_ID),
  ]);
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));

  await Promise.all(operationRows.map(async (operation) => {
    const requirementId = linkedId(operation["Production Requirement"]);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    const requiredQuantity = Math.max(1, Math.floor(Number(requirement?.["Required Quantity"] ?? 1)));
    const status = selectValue(operation.Status, "Planned") as OperationStatus;
    const current = quantitiesForRow(operation, requiredQuantity, status);
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

    const summary = machinistSummary(allocations, requiredQuantity);
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

export async function patchQualityOutcome(operationId: number, result: Exclude<QualityResult, "pending">) {
  if (!hasBaserowCredentials()) return { result };

  const operation = await getRow(OPERATIONS_TABLE_ID, operationId);
  const requirementId = linkedId(operation["Production Requirement"]);
  if (!requirementId) throw new Error("Operation is not linked to a production requirement");

  const requirement = await getRow(REQUIREMENTS_TABLE_ID, requirementId);
  const finishing = selectValue(requirement.Finishing);
  const status = result === "failed"
    ? "Needs Rework"
    : finishing && finishing !== "None"
      ? "Ready for Finishing"
      : "Complete";

  return patchRow(REQUIREMENTS_TABLE_ID, requirementId, {
    "QC Outcome": result === "passed" ? "Passed" : "Failed",
    Status: status,
  });
}

export async function clearPassedQualityOutcome(operationId: number) {
  if (!hasBaserowCredentials()) return;

  const operation = await getRow(OPERATIONS_TABLE_ID, operationId);
  if (selectValue(operation.Status, "Planned") !== "Complete") {
    throw new Error("Only a passed QC review on completed work can be undone");
  }
  const requirementId = linkedId(operation["Production Requirement"]);
  if (!requirementId) throw new Error("Operation is not linked to a production requirement");
  await patchRow(REQUIREMENTS_TABLE_ID, requirementId, {
    "QC Outcome": "Not Inspected",
    Status: "Ready for QC",
  });
}
