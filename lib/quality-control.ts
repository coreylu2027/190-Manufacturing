import type { ManufacturingOperation, QualityControlItem, QualityResult, QualityLocationFields } from "./types.ts";
import type { StorageLocation } from "./storage-locations.ts";
import { isStorageLocation } from "./storage-locations.ts";
import { requiresPassedQc } from "./manufacturing-workflow.ts";

export interface QualityReviewRow {
  id: number;
  production_requirement_id: number | null;
  operation_id: number | null;
  result: "passed" | "failed";
  notes: string;
  reviewed_by: string;
  reviewed_at: string;
  storage_location: string | null;
  location_updated_by: string | null;
  location_updated_at: string | null;
}

export interface QualityProfileRow {
  id: string;
  display_name: string;
}

export interface EffectiveQualityMetadata extends QualityLocationFields {
  reviewId: number | null;
  requirementId: number;
  notes: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

const PENDING_LOCATION: Omit<QualityLocationFields, "effectiveQcResult"> = {
  storageLocation: null,
  locationUpdatedBy: null,
  locationUpdatedAt: null,
};

function timestamp(value: string | null | undefined) {
  return value ? new Date(value).getTime() : Number.NEGATIVE_INFINITY;
}

function latestCompletion(operations: ManufacturingOperation[]) {
  return operations.reduce<string | null>((latest, operation) => {
    if (!operation.completedAt) return latest;
    return !latest || timestamp(operation.completedAt) > timestamp(latest) ? operation.completedAt : latest;
  }, null);
}

export function qualityMetadataByRequirement(
  operationsInput: ManufacturingOperation[],
  reviews: QualityReviewRow[],
  retractedReviewIds: number[],
  profiles: QualityProfileRow[],
) {
  const manufacturingOperations = operationsInput.filter((operation) =>
    operation.workType === "Manufacturing" && operation.requirementId !== null,
  );
  const requirementIdByOperation = new Map(manufacturingOperations.map((operation) => [operation.id, operation.requirementId as number]));
  const operationsByRequirement = new Map<number, ManufacturingOperation[]>();
  for (const operation of manufacturingOperations) {
    const requirementId = operation.requirementId as number;
    operationsByRequirement.set(requirementId, [...(operationsByRequirement.get(requirementId) ?? []), operation]);
  }

  const reviewsByRequirement = new Map<number, QualityReviewRow>();
  for (const review of reviews) {
    const requirementId = review.production_requirement_id
      ?? (review.operation_id ? requirementIdByOperation.get(review.operation_id) : undefined);
    if (!requirementId) continue;
    const current = reviewsByRequirement.get(requirementId);
    if (!current || timestamp(review.reviewed_at) > timestamp(current.reviewed_at)
      || timestamp(review.reviewed_at) === timestamp(current.reviewed_at) && review.id > current.id) {
      reviewsByRequirement.set(requirementId, review);
    }
  }

  const names = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
  const retracted = new Set(retractedReviewIds);
  const metadata = new Map<number, EffectiveQualityMetadata>();
  const requirementIds = new Set([...operationsByRequirement.keys(), ...reviewsByRequirement.keys()]);

  for (const requirementId of requirementIds) {
    const operations = operationsByRequirement.get(requirementId) ?? [];
    const inspectedOperations = operations.filter((operation) => !requiresPassedQc(operation.machine));
    const review = reviewsByRequirement.get(requirementId);
    const completedAt = latestCompletion(inspectedOperations);
    const completedAfterReview = Boolean(
      review
      && inspectedOperations.length > 0
      && inspectedOperations.every((operation) => operation.status === "Complete")
      && completedAt
      && timestamp(completedAt) > timestamp(review.reviewed_at),
    );
    const passedReviewHasIncompleteWork = Boolean(
      review?.result === "passed"
      && inspectedOperations.some((operation) => operation.status !== "Complete"),
    );
    const effectiveQcResult: QualityResult = !review || retracted.has(review.id) || completedAfterReview || passedReviewHasIncompleteWork
      ? "pending"
      : review.result;
    const effectivePass = effectiveQcResult === "passed";
    const storageLocation: StorageLocation | null = effectivePass && isStorageLocation(review?.storage_location)
      ? review.storage_location
      : null;

    metadata.set(requirementId, {
      reviewId: effectiveQcResult === "pending" ? null : review?.id ?? null,
      requirementId,
      effectiveQcResult,
      notes: effectiveQcResult === "pending" ? "" : review?.notes ?? "",
      reviewedAt: effectiveQcResult === "pending" ? null : review?.reviewed_at ?? null,
      reviewedBy: effectiveQcResult === "pending" ? null : names.get(review?.reviewed_by ?? "") ?? null,
      storageLocation,
      locationUpdatedBy: effectivePass ? names.get(review?.location_updated_by ?? "") ?? null : null,
      locationUpdatedAt: effectivePass ? review?.location_updated_at ?? null : null,
    });
  }

  return { metadata, operationsByRequirement };
}

export function enrichOperationsWithQuality(
  operations: ManufacturingOperation[],
  metadata: Map<number, EffectiveQualityMetadata>,
) {
  return operations.map((operation) => {
    const quality = operation.requirementId ? metadata.get(operation.requirementId) : undefined;
    return {
      ...operation,
      storageLocation: quality?.storageLocation ?? null,
      locationUpdatedBy: quality?.locationUpdatedBy ?? null,
      locationUpdatedAt: quality?.locationUpdatedAt ?? null,
      effectiveQcResult: quality?.effectiveQcResult ?? "pending",
    };
  });
}

export function projectQualityControl(
  operationsInput: ManufacturingOperation[],
  reviews: QualityReviewRow[],
  retractedReviewIds: number[],
  profiles: QualityProfileRow[],
): QualityControlItem[] {
  const { metadata, operationsByRequirement } = qualityMetadataByRequirement(
    operationsInput,
    reviews,
    retractedReviewIds,
    profiles,
  );

  return [...operationsByRequirement.entries()]
    .map(([requirementId, operations]) => [
      requirementId,
      operations.filter((operation) => !requiresPassedQc(operation.machine)),
    ] as const)
    .filter(([requirementId, operations]) => operations.length > 0 && (
      operations.every((operation) => operation.status === "Complete") || metadata.get(requirementId)?.effectiveQcResult !== "pending"
    ))
    .map(([requirementId, operations]) => {
      const quality = metadata.get(requirementId) ?? {
        reviewId: null,
        requirementId,
        effectiveQcResult: "pending" as const,
        notes: "",
        reviewedAt: null,
        reviewedBy: null,
        ...PENDING_LOCATION,
      };
      return {
        requirementId,
        operations: [...operations].sort((a, b) => a.operationNumber.localeCompare(b.operationNumber) || a.id - b.id),
        result: quality.effectiveQcResult,
        notes: quality.notes,
        reviewedAt: quality.reviewedAt,
        reviewedBy: quality.reviewedBy,
        storageLocation: quality.storageLocation,
        locationUpdatedBy: quality.locationUpdatedBy,
        locationUpdatedAt: quality.locationUpdatedAt,
        effectiveQcResult: quality.effectiveQcResult,
      };
    })
    .sort((a, b) => Number(a.result !== "pending") - Number(b.result !== "pending")
      || a.operations[0].partNumber.localeCompare(b.operations[0].partNumber));
}
