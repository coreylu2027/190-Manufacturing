// Pure projections from normalized manufacturing rows and the Supabase attachment catalog.
import { deduplicateOperations, requiresPassedQc } from "../manufacturing-workflow.ts";
import type { ManufacturingOperation, FabricationJob, OperationWorkType, OperationStatus, OperationAllocation } from "../types.ts";
import { projectQualityControl, qualityMetadataByRequirement, type QualityReviewRow } from "../quality-control.ts";
import { isStorageLocation } from "../storage-locations.ts";
import type { ManufacturingAttachment, RawRow as SourceRow } from "./model.ts";
function selectValue(value: unknown, fallback = ""): string {
  return typeof value === "object" && value !== null && "value" in value
    ? String((value as { value: unknown }).value ?? fallback)
    : fallback;
}

function operationWorkType(row: SourceRow): OperationWorkType {
  return selectValue(row["Work Type"], "Manufacturing") === "CAM" ? "CAM" : "Manufacturing";
}

function taskQuantityForRow(row: SourceRow, requiredQuantity: number) {
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

function attachmentIndex(attachments: ManufacturingAttachment[]) {
  const index = new Map<string, ManufacturingAttachment>();
  for (const attachment of [...attachments].sort((a, b) => a.position - b.position)) {
    const key = `${attachment.partId}|${attachment.kind}`;
    if (!index.has(key)) index.set(key, attachment);
  }
  return index;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value[0] && typeof value[0] === "object" && "value" in value[0]) {
    return String((value[0] as { value: unknown }).value ?? "").trim();
  }
  return "";
}

function sourceDocumentName(requirement: SourceRow | undefined): string | null {
  if (!requirement) return null;
  return textValue(requirement["Source Document"])
    || textValue(requirement["Onshape Document"])
    || null;
}

function revisionName(requirement: SourceRow | undefined, part: SourceRow | undefined): string | null {
  for (const value of [requirement?.Revision, part?.Revision]) {
    if (typeof value === "number") return String(value);
    const revision = textValue(value) || selectValue(value);
    if (revision) return revision;
  }
  return null;
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

function quantitiesForRow(row: SourceRow, requiredQuantity: number, status: OperationStatus) {
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

function fabricationStatus(requirementStatus: string, machinist: string): ManufacturingOperation["status"] {
  if (requirementStatus === "Complete") return "Complete";
  if (requirementStatus === "Needs Rework") return "Needs Rework";
  if (requirementStatus === "Ready for Finishing") return machinist ? "In Progress" : "Ready";
  return "Planned";
}

export function projectOperations(operationRows: SourceRow[], requirementRows: SourceRow[], partRows: SourceRow[], attachments: ManufacturingAttachment[] = []): ManufacturingOperation[] {
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));
  const parts = new Map(partRows.map((row) => [row.id, row]));
  const files = attachmentIndex(attachments);

  const parsedOperations = operationRows.map((row) => {
    const requirementId = linkedId(row["Production Requirement"]);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    const partId = linkedId(requirement?.Part);
    const part = partId ? parts.get(partId) : undefined;
    const parsed = parseRequirement(linkedValue(row["Production Requirement"]));
    const operationNumber = selectValue(row["Operation Number"], "OP1") as ManufacturingOperation["operationNumber"];
    const machine = selectValue(row.Machine, "Unassigned");
    const storedStatus = selectValue(row.Status, "Planned") as OperationStatus;
    const finishing = selectValue(requirement?.Finishing);
    const finishingRequired = Boolean(finishing && finishing !== "None");
    const requirementStatus = selectValue(requirement?.Status, "Needs Triage");
    const finishingComplete = !finishingRequired
      || selectValue(requirement?.["QC Outcome"]) === "Passed"
        && !["Ready for QC", "Ready for Finishing", "Needs Rework"].includes(requirementStatus);
    const waitingForQcOrFinishing = requiresPassedQc(machine)
      && (selectValue(requirement?.["QC Outcome"]) !== "Passed"
        || Boolean(finishing && finishing !== "None" && selectValue(requirement?.Status) === "Ready for Finishing"));
    const status = waitingForQcOrFinishing && ["Planned", "Ready"].includes(storedStatus)
      ? "Planned"
      : storedStatus;
    const quantity = Number(requirement?.["Required Quantity"] ?? 1);
    const workType = operationWorkType(row);
    const taskQuantity = taskQuantityForRow(row, quantity);
    const quantities = quantitiesForRow(row, taskQuantity, status);
    const drawingPdf = partId ? files.get(`${partId}|drawing-pdf`) : undefined;
    const stepFile = partId ? files.get(`${partId}|step`) : undefined;
    return {
      requirementId,
      requirementKey: textValue(requirement?.["Production Key"]) || null,
      id: row.id,
      operationKey: String(row.Operation ?? `${row.id}`),
      ...parsed,
      revision: revisionName(requirement, part),
      documentName: sourceDocumentName(requirement),
      sourceRoot: textValue(requirement?.["Source Root"]) || null,
      sourceAssemblyRevision: textValue(requirement?.["Source Assembly Revision"]) || null,
      requiredPartRevision: textValue(requirement?.["Required Part Revision"]) || null,
      configuration: textValue(requirement?.Configuration) || null,
      bomPositions: textValue(requirement?.["BOM Positions"]) || null,
      material: textValue(part?.Material) || null,
      finishing: finishing || null,
      finishingRequired,
      finishingComplete,
      requirementStatus,
      requirementMachinist: textValue(requirement?.Machinist) || null,
      activeInBom: Boolean(requirement?.["Active in BOM"]),
      engineeringChanged: Boolean(requirement?.["Engineering Changed"]),
      disposition: selectValue(requirement?.Disposition) || null,
      qualityNotes: "",
      qualityReviewedBy: null,
      qualityReviewedAt: null,
      quantity,
      taskQuantity,
      ...quantities,
      operationNumber,
      workType,
      machine,
      status,
      machinist: String(row.Machinist ?? ""),
      startedAt: row["Started At"] ? String(row["Started At"]) : null,
      completedAt: row["Completed At"] ? String(row["Completed At"]) : null,
      activeInRouting: Boolean(row["Active in Routing"]),
      camProgramPath: textValue(row["CAM Program Path"]) || null,
      camNotes: textValue(row["CAM Notes"]),
      camDependency: null,
      drawingUrl: linkedValue(requirement?.Drawing) || null,
      hasDrawingPdf: Boolean(drawingPdf),
      drawingPdfName: drawingPdf?.originalName ?? null,
      hasStepFile: Boolean(stepFile),
      stepName: stepFile?.originalName ?? null,
      onshapeUrl: requirement?.["Onshape Source"] ? String(requirement["Onshape Source"]) : null,
      storageLocation: isStorageLocation(requirement?.["Part Location"]) ? requirement["Part Location"] : null,
      locationUpdatedBy: textValue(requirement?.["Location Updated By"]) || null,
      locationUpdatedAt: textValue(requirement?.["Location Updated At"]) || null,
      effectiveQcResult: "pending" as const,
    };
  });

  const canonicalOperations = deduplicateOperations(parsedOperations.filter((operation) => operation.activeInRouting));
  const camByTarget = new Map(canonicalOperations
    .filter((operation) => operation.workType === "CAM" && operation.requirementId)
    .map((operation) => [`${operation.requirementId}|${operation.operationNumber}`, operation]));
  const operations: ManufacturingOperation[] = canonicalOperations.map((operation) => {
    if (operation.workType !== "Manufacturing" || !operation.requirementId) return operation;
    const cam = camByTarget.get(`${operation.requirementId}|${operation.operationNumber}`);
    return cam ? {
      ...operation,
      camDependency: {
        operationId: cam.id,
        status: cam.status,
        completedBy: cam.machinist,
        programPath: cam.camProgramPath,
        notes: cam.camNotes,
      },
    } : operation;
  });

  return operations;
}
export function projectFinishing(
  finishingRows: SourceRow[],
  requirementRows: SourceRow[],
  attachments: ManufacturingAttachment[] = [],
  operationRows: SourceRow[] = [],
): FabricationJob[] {
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));
  const files = attachmentIndex(attachments);
  const requirementsWithPostQcWork = new Set(operationRows.filter((row) =>
    Boolean(row["Active in Routing"])
    && operationWorkType(row) === "Manufacturing"
    && requiresPassedQc(selectValue(row.Machine)),
  ).flatMap((row) => {
    const requirementId = linkedId(row["Production Requirement"]);
    return requirementId ? [requirementId] : [];
  }));

  const jobs = finishingRows.flatMap((row): FabricationJob[] => {
    const requirementId = linkedId(row["Production Requirement"]);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    if (!requirementId || !requirement) return [];

    const parsed = parseRequirement(linkedValue(row["Production Requirement"]));
    const machinist = String(row.Machinist ?? "").trim();
    const requirementStatus = selectValue(requirement.Status, "Needs Triage");
    const finishingCompleteBeforePostQcWork = requirementsWithPostQcWork.has(requirementId)
      && selectValue(requirement["QC Outcome"]) === "Passed"
      && requirementStatus !== "Ready for Finishing";
    const partId = linkedId(requirement.Part);
    const drawingPdf = partId ? files.get(`${partId}|drawing-pdf`) : undefined;
    const stepFile = partId ? files.get(`${partId}|step`) : undefined;
    return [{
      id: row.id,
      productionKey: String(row["Production Key"] ?? row.id),
      requirementId,
      ...parsed,
      documentName: sourceDocumentName(requirement),
      quantity: Math.max(1, Math.floor(Number(row["Required Quantity"] ?? requirement["Required Quantity"] ?? 1))),
      color: selectValue(row["Powder Coat Color"], selectValue(requirement.Finishing, "Unspecified")),
      qcNotes: "",
      status: finishingCompleteBeforePostQcWork ? "Complete" : fabricationStatus(requirementStatus, machinist),
      requirementStatus,
      machinist,
      active: Boolean(row.Active),
      lastSyncedAt: row["Last Synced At"] ? String(row["Last Synced At"]) : null,
      drawingUrl: linkedValue(requirement.Drawing) || null,
      hasDrawingPdf: Boolean(drawingPdf),
      drawingPdfName: drawingPdf?.originalName ?? null,
      hasStepFile: Boolean(stepFile),
      stepName: stepFile?.originalName ?? null,
      onshapeUrl: requirement["Onshape Source"] ? String(requirement["Onshape Source"]) : null,
      storageLocation: isStorageLocation(requirement["Part Location"]) ? requirement["Part Location"] : null,
      locationUpdatedBy: textValue(requirement["Location Updated By"]) || null,
      locationUpdatedAt: textValue(requirement["Location Updated At"]) || null,
      effectiveQcResult: "pending" as const,
    }];
  });

  return jobs.filter(job => job.active);
}
export type ReviewRow = Omit<QualityReviewRow, "storage_location" | "location_updated_by" | "location_updated_at"> &
  Partial<Pick<QualityReviewRow, "storage_location" | "location_updated_by" | "location_updated_at">>;

function normalizedReviews(reviews: ReviewRow[]): QualityReviewRow[] {
  return reviews.map((review) => ({
    ...review,
    storage_location: review.storage_location ?? null,
    location_updated_by: review.location_updated_by ?? null,
    location_updated_at: review.location_updated_at ?? null,
  }));
}

export function projectQc(operations: ManufacturingOperation[], reviews: ReviewRow[], users: Array<{id:string;name:string}>) {
  return projectQualityControl(
    operations,
    normalizedReviews(reviews),
    [],
    users.map((user) => ({ id: user.id, display_name: user.name })),
  );
}

function requirementStatus(operations: ManufacturingOperation[]): OperationStatus {
  if (operations.every((operation) => operation.status === "Complete")) return "Complete";
  if (operations.some((operation) => operation.status === "Blocked")) return "Blocked";
  if (operations.some((operation) => operation.status === "Needs Rework")) return "Needs Rework";
  if (operations.some((operation) => operation.status === "In Progress")) return "In Progress";
  if (operations.some((operation) => operation.status === "Ready")) return "Ready";
  return "Planned";
}

export function withFinishingQc(jobs: FabricationJob[], reviews: ReviewRow[], operations: ManufacturingOperation[]) {
  const metadata = qualityMetadataByRequirement(operations, normalizedReviews(reviews), [], []).metadata;
  return jobs.map((job) => ({ ...job, qcNotes: metadata.get(job.requirementId)?.notes ?? "" }));
}

export function projectProduction(operations: ManufacturingOperation[]) {
    const grouped = new Map<string, ManufacturingOperation[]>();

    for (const operation of operations) {
      const key = `${operation.assemblyNumber}|${operation.partNumber}|${operation.revision ?? ""}`;
      grouped.set(key, [...(grouped.get(key) ?? []), operation]);
    }

    return [...grouped.entries()].map(([key, routedOperations]) => {
        const first = routedOperations[0];
        return {
          key,
          partNumber: first.partNumber,
          revision: first.revision,
          partName: first.partName,
          assemblyNumber: first.assemblyNumber,
          documentName: first.documentName,
          quantity: first.quantity,
          completedOperations: routedOperations.filter((operation) => operation.status === "Complete").length,
          totalOperations: routedOperations.length,
          completedCamTasks: routedOperations.filter((operation) => operation.workType === "CAM" && operation.status === "Complete").length,
          totalCamTasks: routedOperations.filter((operation) => operation.workType === "CAM").length,
          completedManufacturingOperations: routedOperations.filter((operation) => operation.workType === "Manufacturing" && operation.status === "Complete").length,
          totalManufacturingOperations: routedOperations.filter((operation) => operation.workType === "Manufacturing").length,
          status: requirementStatus(routedOperations),
        };
      });

}
