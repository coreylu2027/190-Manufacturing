import { createWritePlan } from "./write-plan.ts";
import { deduplicateOperations } from "../manufacturing-workflow.ts";
import { supabaseApiHeaders, type AdapterConfig } from "./supabase-adapter.ts";
import type { NormalizedRow } from "./model.ts";
import type { FabricationAction, OperationPatch, OperationQuantityAction, QualityResult } from "../types.ts";

export class ManufacturingWriteError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export interface WriteState {
  token: string;
  rows: Record<string, NormalizedRow[]>;
  reviews: Array<{ id: number; production_requirement_id: number | null; operation_id: number | null; result: "passed" | "failed"; reviewed_at: string }>;
  retractions: Array<{ review_id: number }>;
}
type Actor = { id: string; name: string };
type Plan = ReturnType<typeof createWritePlan>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createSupabaseWriteAdapter(config: AdapterConfig) {
  const request = config.fetch ?? fetch;
  async function rpc<T>(name: string, body?: unknown): Promise<T> {
    const response = await request(`${config.url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...supabaseApiHeaders(config.serviceKey), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: string; message?: string };
      if (error.code === "40001") throw new ManufacturingWriteError("Manufacturing changed while you were editing. Refresh and try again.", 409);
      if (error.code === "42501") throw new ManufacturingWriteError("Supabase writes are disabled or this account is not authorized.", 403);
      throw new ManufacturingWriteError("Supabase manufacturing transaction failed; no partial transaction was committed.", 502);
    }
    return response.json();
  }
  async function transact<T>(actor: Actor, action: string, build: (plan: Plan, state: WriteState) => Promise<T>, qc: object | null = null) {
    if (!UUID_PATTERN.test(actor.id) || !actor.name.trim()) throw new ManufacturingWriteError("An authenticated manufacturing actor is required", 401);
    const state = await rpc<WriteState>("manufacturing_write_state");
    const plan = createWritePlan(state.rows);
    const result = await build(plan, state);
    const body = { p_request_id: crypto.randomUUID(), p_actor: actor.id, p_action: action,
      p_expected: state.token, p_changes: plan.changes(), p_qc: qc, p_result: result ?? null };
    // A transport failure can occur after commit. Repeat the identical request ID;
    // the database returns the recorded result instead of applying it twice.
    try { return await rpc<T>("manufacturing_commit", body); }
    catch (error) { if (error instanceof ManufacturingWriteError) throw error; return rpc<T>("manufacturing_commit", body); }
  }
  function operation(state: WriteState, id: number) {
    const row = state.rows.operations.find(row => row.id === id);
    if (!row || !row.active_in_routing) throw new ManufacturingWriteError("This operation is no longer active", 409);
    const canonical = deduplicateOperations(state.rows.operations.filter(row => row.active_in_routing).map(row => ({
      id: row.id, operationKey: String(row.operation_key ?? ""), workType: row.work_type === "CAM" ? "CAM" as const : "Manufacturing" as const,
      status: row.status as import("../types.ts").OperationStatus, claimedQuantity: Number(row.claimed_quantity ?? 0), completedQuantity: Number(row.completed_quantity ?? 0),
      startedAt: row.started_at as string | null, completedAt: row.completed_at as string | null,
    })));
    if (!canonical.some(row => row.id === id)) throw new ManufacturingWriteError("This duplicate operation is not the active production record", 409);
    return row;
  }
  return {
    async retractedReviewIds() {
      return (await rpc<WriteState>("manufacturing_write_state")).retractions.map(row => row.review_id);
    },
    applyQuantityAction(id: number, action: OperationQuantityAction, quantity: number, actor: Actor, handoff?: { programPath?: string; notes?: string }) {
      return transact(actor, action, async (plan, state) => { operation(state, id); return plan.applyQuantityAction(id, action, quantity, actor, handoff); });
    },
    stealOperationClaim(id: number, actor: Actor) {
      return transact(actor, "steal", async (plan, state) => { operation(state, id); return plan.stealOperationClaim(id, actor); });
    },
    patchOperation(id: number, patch: OperationPatch, actor: Actor) {
      return transact(actor, "patch_operation", async (plan, state) => {
        const row = operation(state, id);
        const requirement = state.rows.requirements.find(r => r.id === row.requirement_id);
        if (requirement?.qc_outcome === "Passed") throw new ManufacturingWriteError("Undo the passed QC review before editing completed work", 409);
        if (patch.status === "Complete" || patch.status === "In Progress" || row.status === "Complete" && patch.status !== "Needs Rework") {
          throw new ManufacturingWriteError("Use quantity actions to claim, complete, or reopen work", 409);
        }
        if (row.work_type === "CAM" && row.status === "Complete") throw new ManufacturingWriteError("Use undo completion to reopen CAM", 409);
        if (Number(row.claimed_quantity ?? 0) + Number(row.completed_quantity ?? 0) > 0 && ["Planned", "Ready"].includes(patch.status ?? "")) {
          throw new ManufacturingWriteError("Release or undo allocated work before resetting its status", 409);
        }
        return plan.patchOperation(id, patch, actor.name);
      });
    },
    updateCamHandoff(id: number, patch: { completedBy: string; programPath: string; notes: string }, actor: Actor) {
      return transact(actor, "cam_handoff", async (plan, state) => { operation(state, id); return plan.updateCamHandoff(id, patch); });
    },
    applyFabricationAction(id: number, action: FabricationAction, actor: Actor) {
      return transact(actor, `finishing_${action}`, plan => plan.applyFabricationAction(id, action, actor));
    },
    renameMachinistAllocations(userId: string, oldName: string, newName: string) {
      return transact({ id: userId, name: newName }, "rename", plan => plan.renameMachinistAllocations(userId, oldName, newName));
    },
    recordQualityReview(requirementId: number, result: Exclude<QualityResult, "pending">, notes: string, actor: Actor) {
      const reviewedAt = new Date().toISOString();
      return transact(actor, "qc_review", async plan => {
        await plan.patchRequirementQualityOutcome(requirementId, result, actor.name, notes, reviewedAt);
        return { requirementId, result, notes };
      }, { requirement_id: requirementId, result, notes, reviewed_at: reviewedAt });
    },
    undoQualityReview(requirementId: number, actor: Actor) {
      return transact(actor, "qc_undo", async (plan, state) => {
        const review = state.reviews.filter(r => r.production_requirement_id === requirementId || r.production_requirement_id === null && state.rows.operations.some(o => o.id === r.operation_id && o.requirement_id === requirementId))
          .sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at) || b.id - a.id)[0];
        if (!review || review.result !== "passed" || state.retractions.some(r => r.review_id === review.id)) throw new ManufacturingWriteError("Only the latest passed QC review can be undone", 409);
        await plan.clearPassedRequirementQualityOutcome(requirementId);
        return { undone: true, requirementId };
      }, { requirement_id: requirementId });
    },
  };
}
