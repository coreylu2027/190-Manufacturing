import "server-only";
import { createSupabaseManufacturingAdapter } from "./supabase-adapter";
import { manufacturingSupabaseConfig } from "./config";
import { createSupabaseWriteAdapter } from "./write-adapter";
import type { FabricationAction, OperationPatch, OperationQuantityAction, QualityResult } from "../types";

type Actor = { id: string; name: string };

function reader() {
  return createSupabaseManufacturingAdapter(manufacturingSupabaseConfig());
}

function writer() {
  return createSupabaseWriteAdapter(manufacturingSupabaseConfig());
}

export async function getOperations() {
  return reader().getOperations();
}

export async function getFabricationJobs() {
  return reader().getFabricationJobs();
}

export async function applyQuantityAction(id: number, action: OperationQuantityAction, quantity: number, actor: Actor, handoff?: { programPath?: string; notes?: string }) {
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

export async function recordQualityReview(requirementId: number, result: Exclude<QualityResult, "pending">, notes: string, actor: Actor) {
  return writer().recordQualityReview(requirementId, result, notes, actor);
}

export async function undoQualityReview(requirementId: number, actor: Actor) {
  return writer().undoQualityReview(requirementId, actor);
}

export async function getRetractedQualityReviewIds(): Promise<number[]> {
  return writer().retractedReviewIds();
}
