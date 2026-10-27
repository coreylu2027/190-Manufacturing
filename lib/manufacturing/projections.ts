import { projectObsoletion } from "../obsoletion.ts";
import { requirementIdentity } from "./identity.ts";
// Pure projections from normalized manufacturing rows and the Supabase attachment catalog.
import { deduplicateOperations, isFinishingComplete, isPostQcOperation, normalizeOperationStatus } from "../manufacturing-workflow.ts";
import type { CotsRequirement, ManufacturingOperation, FabricationJob } from "../types.ts";
import { isStorageLocation } from "../storage-locations.ts";
import type { ManufacturingAttachment, NormalizedRow } from "./model.ts";
import { fabricationStatus, linkedId, operationWorkType, quantitiesForRow, selectValue, taskQuantityForRow, textValue } from "./rows.ts";

function attachmentIndex(attachments: ManufacturingAttachment[]) {
  const index = new Map<string, ManufacturingAttachment>();
  for (const attachment of [...attachments].sort((a, b) => a.position - b.position)) {
    const key = `${attachment.partId}|${attachment.kind}`;
    if (!index.has(key)) index.set(key, attachment);
  }
  return index;
}

function sourceDocumentName(requirement: NormalizedRow | undefined): string | null {
  if (!requirement) return null;
  return textValue(requirement.source_document) || null;
}

/**
 * The Onshape document each root assembly lives in, keyed by root assembly
 * number. The sync records only the root (Source Root). The root assembly's own
 * parts report its document; parts of imported subassemblies (a configurable
 * roller, say) report the subassembly's document instead. So the root's
 * document is the most common one among its direct parts, preferring active ones.
 */
function syncedFromDocuments(requirementRows: NormalizedRow[], assemblies: Map<number, NormalizedRow>) {
  const tallies = [new Map<string, Map<string, number>>(), new Map<string, Map<string, number>>()];
  for (const requirement of requirementRows) {
    const root = textValue(requirement.source_root);
    const document = sourceDocumentName(requirement);
    const assembly = assemblies.get(linkedId(requirement.assembly_id) ?? -1);
    if (!root || !document || String(assembly?.assembly_number ?? "").trim() !== root) continue;
    const current = requirement.active_in_bom !== false && requirement.obsolete !== true;
    for (const tally of current ? tallies : tallies.slice(1)) {
      const documents = tally.get(root) ?? new Map<string, number>();
      documents.set(document, (documents.get(document) ?? 0) + 1);
      tally.set(root, documents);
    }
  }
  const result = new Map<string, string>();
  for (const tally of tallies) {
    for (const [root, documents] of tally) {
      if (result.has(root)) continue;
      result.set(root, [...documents].sort(([left, a], [right, b]) => b - a || left.localeCompare(right))[0][0]);
    }
  }
  return result;
}

function qcPoint(requirement: NormalizedRow | undefined): number | null {
  const value = requirement?.qc_after_operation;
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function revisionName(requirement: NormalizedRow | undefined, part: NormalizedRow | undefined): string | null {
  return textValue(requirement?.required_part_revision) || textValue(part?.revision) || null;
}

export function projectOperations(operationRows: NormalizedRow[], requirementRows: NormalizedRow[], partRows: NormalizedRow[], attachments: ManufacturingAttachment[] = [], assemblyRows: NormalizedRow[] = []): ManufacturingOperation[] {
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));
  const parts = new Map(partRows.map((row) => [row.id, row]));
  const assemblies = new Map(assemblyRows.map((row) => [row.id, row]));
  const files = attachmentIndex(attachments);
  const rootDocuments = syncedFromDocuments(requirementRows, assemblies);

  const parsedOperations = operationRows.map((row) => {
    const requirementId = linkedId(row.requirement_id);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    const partId = linkedId(requirement?.part_id);
    const part = partId ? parts.get(partId) : undefined;
    const parsed = requirementIdentity(requirement, part,
      assemblies.get(linkedId(requirement?.assembly_id) ?? -1));
    const operationNumber = selectValue(row.operation_number, "OP1") as ManufacturingOperation["operationNumber"];
    const machine = selectValue(row.machine, "Unassigned");
    const storedStatus = normalizeOperationStatus(selectValue(row.status, "Planned"));
    const finishing = selectValue(requirement?.finishing);
    const finishingRequired = Boolean(finishing && finishing !== "None");
    const requirementStatus = selectValue(requirement?.status, "Needs Triage");
    const finishingComplete = isFinishingComplete({
      finishingRequired, qcPassed: selectValue(requirement?.qc_outcome) === "Passed", status: requirementStatus,
    });
    const qcAfterOperation = qcPoint(requirement);
    const waitingForQcOrFinishing = operationWorkType(row) === "Manufacturing" && isPostQcOperation({ machine, operationNumber }, qcAfterOperation)
      && (selectValue(requirement?.qc_outcome) !== "Passed"
        || Boolean(finishing && finishing !== "None" && selectValue(requirement?.status) === "Ready for Finishing"));
    const status = waitingForQcOrFinishing && ["Planned", "Ready"].includes(storedStatus)
      ? "Planned"
      : storedStatus;
    const quantity = Number(requirement?.required_quantity ?? 1);
    const workType = operationWorkType(row);
    const taskQuantity = taskQuantityForRow(row, quantity);
    const quantities = quantitiesForRow(row, taskQuantity, status);
    const drawingPdf = partId ? files.get(`${partId}|drawing-pdf`) : undefined;
    const stepFile = partId ? files.get(`${partId}|step`) : undefined;
    return {
      requirementId,
      requirementKey: textValue(requirement?.production_key) || null,
      id: row.id,
      ...projectObsoletion(requirement),
      operationKey: String(row.operation_key ?? `${row.id}`),
      ...parsed,
      revision: revisionName(requirement, part),
      documentName: sourceDocumentName(requirement),
      syncedFromDocument: rootDocuments.get(textValue(requirement?.source_root)) ?? null,
      qcAfterOperation,
      sourceRoot: textValue(requirement?.source_root) || null,
      sourceAssemblyRevision: textValue(requirement?.source_assembly_revision) || null,
      requiredPartRevision: textValue(requirement?.required_part_revision) || null,
      configuration: textValue(requirement?.configuration) || null,
      bomPositions: textValue(requirement?.bom_positions) || null,
      material: textValue(part?.material) || null,
      finishing: finishing || null,
      finishingRequired,
      finishingComplete,
      requirementStatus,
      requirementMachinist: textValue(requirement?.machinist) || null,
      activeInBom: Boolean(requirement?.active_in_bom),
      engineeringChanged: Boolean(requirement?.engineering_changed),
      disposition: selectValue(requirement?.disposition) || null,
      productionNotes: textValue(requirement?.production_notes),
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
      machinist: String(row.machinist ?? ""),
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      activeInRouting: Boolean(row.active_in_routing),
      camProgramPath: textValue(row.cam_program_path) || null,
      camNotes: textValue(row.cam_notes),
      camDependency: null,
      drawingUrl: part ? textValue(part.drawing_url) || null : null,
      hasDrawingPdf: Boolean(drawingPdf),
      drawingPdfName: drawingPdf?.originalName ?? null,
      hasStepFile: Boolean(stepFile),
      stepName: stepFile?.originalName ?? null,
      onshapeUrl: requirement?.onshape_url ? String(requirement.onshape_url) : null,
      storageLocation: isStorageLocation(requirement?.part_location) ? requirement.part_location : null,
      locationUpdatedBy: textValue(requirement?.location_updated_by) || null,
      locationUpdatedAt: textValue(requirement?.location_updated_at) || null,
      effectiveQcResult: "pending" as const,
      lastQualityFailure: null,
    };
  });

  const activeRequirements = new Set(parsedOperations.filter((operation) => operation.activeInRouting).map((operation) => operation.requirementId));
  const canonicalOperations = deduplicateOperations(parsedOperations.filter((operation) => operation.activeInRouting
    || !activeRequirements.has(operation.requirementId) && (operation.obsolete || operation.obsoletionVersion > 0 || operation.offTheShelf)));
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
/**
 * Purchased (COTS) parts sync with requirements but no routing, so they never
 * appear among operations. A COTS requirement that was given routing anyway is
 * left to the operations projection.
 */
export function projectCotsRequirements(
  requirementRows: NormalizedRow[],
  partRows: NormalizedRow[],
  assemblyRows: NormalizedRow[] = [],
  operations: Pick<ManufacturingOperation, "requirementId">[] = [],
): CotsRequirement[] {
  const parts = new Map(partRows.map((row) => [row.id, row]));
  const assemblies = new Map(assemblyRows.map((row) => [row.id, row]));
  const rootDocuments = syncedFromDocuments(requirementRows, assemblies);
  const routed = new Set(operations.map((operation) => operation.requirementId));

  return requirementRows.flatMap((requirement): CotsRequirement[] => {
    const part = parts.get(linkedId(requirement.part_id) ?? -1);
    if (part?.cots !== true || routed.has(requirement.id)) return [];
    const obsoletion = projectObsoletion(requirement);
    const activeInBom = Boolean(requirement.active_in_bom);
    if (!activeInBom && !obsoletion.obsolete && obsoletion.obsoletionVersion === 0) return [];
    return [{
      requirementId: requirement.id,
      requirementKey: textValue(requirement.production_key) || null,
      ...obsoletion,
      ...requirementIdentity(requirement, part, assemblies.get(linkedId(requirement.assembly_id) ?? -1)),
      revision: revisionName(requirement, part),
      documentName: sourceDocumentName(requirement),
      syncedFromDocument: rootDocuments.get(textValue(requirement.source_root)) ?? null,
      sourceRoot: textValue(requirement.source_root) || null,
      sourceAssemblyRevision: textValue(requirement.source_assembly_revision) || null,
      requiredPartRevision: textValue(requirement.required_part_revision) || null,
      configuration: textValue(requirement.configuration) || null,
      bomPositions: textValue(requirement.bom_positions) || null,
      material: textValue(part.material) || null,
      vendor: textValue(part.vendor) || null,
      requirementStatus: selectValue(requirement.status, "Needs Triage"),
      requirementMachinist: textValue(requirement.machinist) || null,
      activeInBom,
      engineeringChanged: Boolean(requirement.engineering_changed),
      disposition: selectValue(requirement.disposition) || null,
      productionNotes: textValue(requirement.production_notes),
      quantity: Number(requirement.required_quantity ?? 1),
      onshapeUrl: textValue(requirement.onshape_url) || null,
      storageLocation: isStorageLocation(requirement.part_location) ? requirement.part_location : null,
      locationUpdatedBy: textValue(requirement.location_updated_by) || null,
      locationUpdatedAt: textValue(requirement.location_updated_at) || null,
      effectiveQcResult: "pending",
      lastQualityFailure: null,
    }];
  });
}

export function projectFinishing(
  finishingRows: NormalizedRow[],
  requirementRows: NormalizedRow[],
  attachments: ManufacturingAttachment[] = [],
  operationRows: NormalizedRow[] = [],
  partRows: NormalizedRow[] = [],
  assemblyRows: NormalizedRow[] = [],
): FabricationJob[] {
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));
  const parts = new Map(partRows.map((row) => [row.id, row]));
  const assemblies = new Map(assemblyRows.map((row) => [row.id, row]));
  const files = attachmentIndex(attachments);
  const requirementsWithPostQcWork = new Set(operationRows.filter((row) =>
    Boolean(row.active_in_routing)
    && operationWorkType(row) === "Manufacturing"
    && isPostQcOperation({ machine: selectValue(row.machine), operationNumber: selectValue(row.operation_number, "OP1") },
      qcPoint(requirements.get(linkedId(row.requirement_id) ?? -1))),
  ).flatMap((row) => {
    const requirementId = linkedId(row.requirement_id);
    return requirementId ? [requirementId] : [];
  }));

  const jobs = finishingRows.flatMap((row): FabricationJob[] => {
    const requirementId = linkedId(row.requirement_id);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    if (!requirementId || !requirement) return [];

    const part = parts.get(linkedId(requirement.part_id) ?? -1);
    const parsed = requirementIdentity(requirement, part,
      assemblies.get(linkedId(requirement.assembly_id) ?? -1));
    const machinist = String(row.machinist ?? "").trim();
    const requirementStatus = selectValue(requirement.status, "Needs Triage");
    const finishingCompleteBeforePostQcWork = requirementsWithPostQcWork.has(requirementId)
      && selectValue(requirement.qc_outcome) === "Passed"
      && requirementStatus !== "Ready for Finishing";
    const partId = linkedId(requirement.part_id);
    const drawingPdf = partId ? files.get(`${partId}|drawing-pdf`) : undefined;
    const stepFile = partId ? files.get(`${partId}|step`) : undefined;
    return [{
      id: row.id,
      ...projectObsoletion(requirement),
      productionKey: String(row.production_key ?? row.id),
      requirementId,
      ...parsed,
      documentName: sourceDocumentName(requirement),
      quantity: Math.max(1, Math.floor(Number(row.required_quantity ?? requirement.required_quantity ?? 1))),
      color: selectValue(row.color, selectValue(requirement.finishing, "Unspecified")),
      productionNotes: textValue(requirement.production_notes),
      qcNotes: "",
      status: finishingCompleteBeforePostQcWork ? "Complete" : fabricationStatus(requirementStatus, machinist),
      requirementStatus,
      machinist,
      active: Boolean(row.active) && requirement.active_in_bom !== false,
      lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
      drawingUrl: part ? textValue(part.drawing_url) || null : null,
      hasDrawingPdf: Boolean(drawingPdf),
      drawingPdfName: drawingPdf?.originalName ?? null,
      hasStepFile: Boolean(stepFile),
      stepName: stepFile?.originalName ?? null,
      onshapeUrl: requirement.onshape_url ? String(requirement.onshape_url) : null,
      storageLocation: isStorageLocation(requirement.part_location) ? requirement.part_location : null,
      locationUpdatedBy: textValue(requirement.location_updated_by) || null,
      locationUpdatedAt: textValue(requirement.location_updated_at) || null,
      effectiveQcResult: "pending" as const,
      lastQualityFailure: null,
    }];
  });

  return jobs.filter(job => job.active || job.obsolete || job.obsoletionVersion > 0);
}
