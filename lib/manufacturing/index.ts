import "server-only";
import { createSupabaseManufacturingAdapter } from "./supabase-adapter";
import { manufacturingSupabaseConfig } from "./config";
import { createSupabaseWriteAdapter } from "./write-adapter";
import type { FabricationAction, OperationPatch, OperationQuantityAction, QualityResult } from "../types";
import type { StorageLocation } from "../storage-locations";
import type { EngineeringOverrideFields, OverrideFileKind } from "../engineering-overrides";

type Actor = { id: string; name: string };

function reader() {
  return createSupabaseManufacturingAdapter(manufacturingSupabaseConfig());
}

function writer() {
  return createSupabaseWriteAdapter(manufacturingSupabaseConfig());
}

export async function setRequirementObsolete(requirementId: number, obsolete: boolean, expectedVersion: number, actor: Actor) {
  return writer().setRequirementObsolete(requirementId, obsolete, expectedVersion, actor);
}

export async function setRequirementHidden(requirementId: number, hidden: boolean, expectedVersion: number, actor: Actor) {
  return writer().setRequirementHidden(requirementId, hidden, expectedVersion, actor);
}

export async function readEngineeringOverrideState(requirementId: number) {
  return writer().readEngineeringOverrideState(requirementId);
}

export async function readRequirementHistory(requirementId: number) {
  return writer().readRequirementHistory(requirementId);
}

export async function readEngineeringCorrections() {
  return writer().readEngineeringCorrections();
}

export async function applyEngineeringOverrides(requirementId: number, fields: EngineeringOverrideFields, expectedToken: string, reason: string, actor: Actor) {
  return writer().applyEngineeringOverrides(requirementId, fields, expectedToken, reason, actor);
}

export async function setAttachmentOverride(requirementId: number, kind: OverrideFileKind, file: { name: string; sha256: string; byteSize: number } | null, expectedToken: string, reason: string, actor: Actor) {
  return writer().setAttachmentOverride(requirementId, kind, file, expectedToken, reason, actor);
}

export async function getOperations() {
  return reader().getOperations();
}

export async function getFabricationJobs() {
  return reader().getFabricationJobs();
}

export async function getManufacturingDataVersion() {
  return reader().readDataVersion();
}

export async function getManufacturingSnapshot() {
  return reader().readSnapshot();
}

export async function applyQuantityAction(id: number, action: OperationQuantityAction, quantity: number, actor: Actor, handoff?: { programPath?: string; notes?: string; location?: StorageLocation; completeAllClaims?: boolean }) {
  return writer().applyQuantityAction(id, action, quantity, actor, handoff);
}

export async function stealOperationClaim(id: number, actor: Actor) {
  return writer().stealOperationClaim(id, actor);
}

export async function patchOperation(id: number, patch: OperationPatch, actor: Actor) {
  return writer().patchOperation(id, patch, actor);
}

export async function updateCamHandoff(id: number, patch: { completedBy: string; programPath: string; notes: string }, actor: Actor) {
  return writer().updateCamHandoff(id, patch, actor);
}

export async function applyFabricationAction(id: number, action: FabricationAction, actor: Actor) {
  return writer().applyFabricationAction(id, action, actor);
}

export async function renameMachinistAllocations(userId: string, oldName: string, newName: string) {
  return writer().renameMachinistAllocations(userId, oldName, newName);
}

export async function recordQualityReview(
  requirementId: number,
  result: Exclude<QualityResult, "pending">,
  notes: string,
  actor: Actor,
  location: StorageLocation | null = null,
  rejectedQuantity?: number,
) {
  return writer().recordQualityReview(requirementId, result, notes, actor, location, rejectedQuantity);
}

export async function updateRequirementNotes(requirementId: number, notes: string, actor: Actor) {
  return writer().updateRequirementNotes(requirementId, notes, actor);
}

export async function updatePassedQualityNotes(requirementId: number, notes: string, actor: Actor) {
  return writer().updatePassedQualityNotes(requirementId, notes, actor);
}

export async function updatePartLocation(requirementId: number, location: StorageLocation | null, actor: Actor) {
  return writer().updatePartLocation(requirementId, location, actor);
}

export async function previewForceQuality(requirementId: number) {
  return writer().previewForceQuality(requirementId);
}

export async function forceQualityReview(requirementId: number, notes: string, token: string, actor: Actor, result: "passed" | "failed" = "passed") {
  return writer().forceQualityReview(requirementId, notes, token, actor, result);
}

export const updateQualityLocation = updatePartLocation;

export async function undoQualityReview(requirementId: number, actor: Actor) {
  return writer().undoQualityReview(requirementId, actor);
}

export async function getRetractedQualityReviewIds(): Promise<number[]> {
  return writer().retractedReviewIds();
}
