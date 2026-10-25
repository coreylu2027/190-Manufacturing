import { createWritePlan } from "./write-plan.ts";
import { deduplicateOperations, isFinishingComplete, isPostQcOperation, normalizeOperationStatus } from "../manufacturing-workflow.ts";
import { createSupabaseManufacturingAdapter, supabaseApiHeaders, type AdapterConfig } from "./supabase-adapter.ts";
import type { NormalizedRow } from "./model.ts";
import type { FabricationAction, OperationPatch, OperationQuantityAction, OperationStatus, QualityResult } from "../types.ts";
import { ROBOT_LOCATION, isStorageLocation, isPrintingOperation, type StorageLocation } from "../storage-locations.ts";
import { robotPlacementAllowed } from "../obsoletion.ts";
import type { QualityReviewRow } from "../quality-control.ts";

import { notificationPartContext as resolvePartContext } from "./identity.ts";
import { EngineeringOverrideError, planEngineeringOverrides } from "./engineering-override-plan.ts";
import type { EngineeringCorrection, EngineeringOverrideFields, EngineeringOverrideState, OverrideFileKind } from "../engineering-overrides.ts";
import type { RequirementHistoryPayload } from "../requirement-history.ts";
import { ManufacturingWriteError } from "./errors.ts";

export { ManufacturingWriteError };

const STALE_OVERRIDE_MESSAGE = "Onshape data or another adjustment changed. Review the latest values and try again.";

export interface WriteState {
  token: string;
  rows: Record<string, NormalizedRow[]>;
  reviews: QualityReviewRow[];
  retractions: Array<{ review_id: number }>;
}
type Actor = { id: string; name: string };
type Plan = ReturnType<typeof createWritePlan>;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The planner rejects workflow-rule violations with plain Errors; they conflict with the current state rather than being upstream failures. */
function asConflict(error: unknown) {
  return error instanceof Error && error.constructor === Error ? new ManufacturingWriteError(error.message, 409) : error;
}
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
      if (error.code === "40001" || error.code === "PT409" || response.status === 409) {
        throw new ManufacturingWriteError(
          error.message && error.message !== "Manufacturing state changed"
            ? error.message
            : "Manufacturing changed while you were editing. Refresh and try again.",
          409,
        );
      }
      if (error.code === "42501") throw new ManufacturingWriteError("Supabase writes are disabled or this account is not authorized.", 403);
      if (error.code === "57014" || error.code === "55P03") {
        throw new ManufacturingWriteError("The manufacturing database is busy. Wait a moment and try again.", 503);
      }
      throw new ManufacturingWriteError("Supabase manufacturing transaction failed; no partial transaction was committed.", 502);
    }
    return response.json();
  }
  async function transact<T>(
    actor: Actor,
    action: string,
    build: (plan: Plan, state: WriteState) => T,
    qc: object | ((state: WriteState, result: T) => object | null) | null = null,
    commitRpc = "manufacturing_commit_with_qc_quantities",
  ) {
    if (!UUID_PATTERN.test(actor.id) || !actor.name.trim()) throw new ManufacturingWriteError("An authenticated manufacturing actor is required", 401);
    const state = await rpc<WriteState>("manufacturing_write_state");
    const reader = createSupabaseManufacturingAdapter(config);
    const [parts, assemblies] = await Promise.all([
      state.rows.parts ?? reader.readEntity("parts"),
      state.rows.assemblies ?? reader.readEntity("assemblies"),
    ]);
    state.rows = { ...state.rows, parts, assemblies };
    const plan = createWritePlan(state.rows);
    let result: T;
    try { result = build(plan, state); }
    catch (error) { throw asConflict(error); }
    const qualityPayload = typeof qc === "function" ? qc(state, result) : qc;
    const body = { p_request_id: crypto.randomUUID(), p_actor: actor.id, p_action: action,
      p_expected: state.token, p_changes: plan.changes(), p_qc: qualityPayload, p_result: result ?? null };
    // A transport failure can occur after commit. Repeat the identical request ID;
    // the database returns the recorded result instead of applying it twice.
    try { return await rpc<T>(commitRpc, body); }
    catch (error) { if (error instanceof ManufacturingWriteError) throw error; return rpc<T>(commitRpc, body); }
  }
  function operation(state: WriteState, id: number) {
    const row = state.rows.operations.find(row => row.id === id);
    if (!row || !row.active_in_routing) throw new ManufacturingWriteError("This operation is no longer active", 409);
    assertWorkAllowed(state, Number(row.requirement_id));
    const canonical = deduplicateOperations(state.rows.operations.filter(row => row.active_in_routing).map(row => ({
      id: row.id, operationKey: String(row.operation_key ?? ""), workType: row.work_type === "CAM" ? "CAM" as const : "Manufacturing" as const,
      status: normalizeOperationStatus(row.status), claimedQuantity: Number(row.claimed_quantity ?? 0), completedQuantity: Number(row.completed_quantity ?? 0),
      startedAt: row.started_at as string | null, completedAt: row.completed_at as string | null,
    })));
    if (!canonical.some(row => row.id === id)) throw new ManufacturingWriteError("This duplicate operation is not the active production record", 409);
    return row;
  }
  function latestReview(state: WriteState, requirementId: number) {
    return state.reviews.filter((review) => review.production_requirement_id === requirementId
      || review.production_requirement_id === null
        && state.rows.operations.some((candidate) => candidate.id === review.operation_id && candidate.requirement_id === requirementId))
      .sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at) || b.id - a.id)[0];
  }
  function requirement(state: WriteState, requirementId: number) {
    const row = state.rows.requirements.find((candidate) => candidate.id === requirementId);
    if (!row) throw new ManufacturingWriteError("Production requirement no longer exists", 409);
    return row;
  }
  function assertWorkAllowed(state: WriteState, requirementId: number) {
    const row = requirement(state, requirementId);
    if (row.obsolete) throw new ManufacturingWriteError("This requirement is obsolete. Do not manufacture or install it.", 409);
    if (!row.active_in_bom) throw new ManufacturingWriteError("This requirement is inactive in the BOM", 409);
    return row;
  }
  /** Adds the part and assembly rows that the write-state snapshot omits. */
  async function withIdentityRows(state: WriteState) {
    const reader = createSupabaseManufacturingAdapter(config);
    const [parts, assemblies] = await Promise.all([
      state.rows.parts ?? reader.readEntity("parts"),
      state.rows.assemblies ?? reader.readEntity("assemblies"),
    ]);
    return { ...state.rows, parts, assemblies };
  }
  function notificationPartContext(state: WriteState, requirementId: number) {
    requirement(state, requirementId);
    return { ...resolvePartContext(state.rows, requirementId), requirementId };
  }
  /** A manufacturing operation that waits for its requirement's QC pass; CAM never does. */
  function afterQc(state: WriteState, row: NormalizedRow) {
    const qcAfter = state.rows.requirements.find((candidate) => candidate.id === row.requirement_id)?.qc_after_operation;
    return row.work_type === "Manufacturing" && isPostQcOperation(
      { machine: String(row.machine ?? ""), operationNumber: String(row.operation_number ?? "OP1") },
      qcAfter == null ? null : Number(qcAfter));
  }
  /**
   * Whether the plan makes post-QC manufacturing work claimable that was not before. Such work
   * is claimable once its requirement passed QC and finished any finishing, and its operation is
   * Ready or In Progress (so not while it still waits on CAM).
   */
  function releasesPostQcWork(state: WriteState, plan: Plan) {
    const changes = plan.changes();
    const planned = (entity: string, row: NormalizedRow) =>
      ({ ...row, ...changes.find((change) => change.entity === entity && change.id === row.id)?.patch });
    const released = (requirement: NormalizedRow | undefined) => requirement?.qc_outcome === "Passed"
      && !(requirement.finishing && requirement.finishing !== "None" && requirement.status === "Ready for Finishing");
    const claimable = (operation: NormalizedRow, requirement: NormalizedRow | undefined) =>
      Boolean(operation.active_in_routing) && afterQc(state, operation) && released(requirement)
      && (operation.status === "Ready" || operation.status === "In Progress");
    return state.rows.operations.some((operation) => {
      const requirement = state.rows.requirements.find((row) => row.id === operation.requirement_id);
      return !claimable(operation, requirement)
        && claimable(planned("operations", operation), requirement && planned("requirements", requirement));
    });
  }
  function assertEffectivePassedReview(
    state: WriteState,
    requirementId: number,
    message = "A location can only be edited for the latest effective passed QC review",
  ) {
    const review = latestReview(state, requirementId);
    const requirementOperations = state.rows.operations.filter((row) => row.requirement_id === requirementId);
    // A requirement restored from obsolete keeps its deactivated routing, which
    // then remains the record of the inspected work.
    const routed = requirementOperations.some((row) => row.active_in_routing);
    const manufacturingOperations = deduplicateOperations(requirementOperations.filter((row) =>
      (row.active_in_routing || !routed) && row.work_type === "Manufacturing" && !afterQc(state, row),
    ).map((row) => ({
      id: row.id,
      operationKey: String(row.operation_key ?? ""),
      workType: "Manufacturing" as const,
      status: row.status as OperationStatus,
      completedAt: row.completed_at as string | null,
    })));
    const stale = manufacturingOperations.length === 0
      || !manufacturingOperations.every((candidate) => candidate.status === "Complete")
      || manufacturingOperations.some((candidate) => candidate.completedAt
        && new Date(candidate.completedAt).getTime() > new Date(review?.reviewed_at ?? "").getTime());
    if (!review || review.result !== "passed" || state.retractions.some((item) => item.review_id === review.id) || stale) {
      throw new ManufacturingWriteError(message, 409);
    }
    return review;
  }
  function hasCurrentPass(state: WriteState, requirementId: number) {
    try { assertEffectivePassedReview(state, requirementId); return true; }
    catch (error) { if (error instanceof ManufacturingWriteError) return false; throw error; }
  }
  function assertForceEligible(state: WriteState, requirementId: number) {
    assertWorkAllowed(state, requirementId);
    if (hasCurrentPass(state, requirementId)) throw new ManufacturingWriteError("This requirement already has a current QC pass", 409);
  }
  return {
    async previewForceQuality(requirementId: number) {
      const state = await rpc<WriteState>("manufacturing_write_state");
      assertForceEligible(state, requirementId);
      try { return { ...createWritePlan(state.rows).previewForceQuality(requirementId), token: state.token }; }
      catch (error) { throw asConflict(error); }
    },
    forceQualityReview(requirementId: number, notes: string, token: string, actor: Actor, result: "passed" | "failed" = "passed", completeFinishing = false) {
      const reviewedAt = new Date().toISOString();
      if (completeFinishing && result !== "passed") return Promise.reject(new ManufacturingWriteError("Finishing can only be completed when QC passes", 400));
      if (result === "failed" && !notes.trim()) return Promise.reject(new ManufacturingWriteError("Enter a reason for the QC failure", 400));
      return transact(actor, "qc_review", (plan, state) => {
        if (token !== state.token) throw new ManufacturingWriteError("Manufacturing changed. Refresh the preview and review the affected work before submitting again.", 409);
        assertForceEligible(state, requirementId);
        plan.forceCompletePrerequisites(requirementId, actor, reviewedAt);
        // A forced failure rejects the whole batch, which the database requires as an explicit quantity.
        const rejectedQuantity = result === "failed"
          ? Math.max(1, Math.floor(Number(requirement(state, requirementId).required_quantity ?? 1)))
          : null;
        let requirementStatus = plan.patchRequirementQualityOutcome(requirementId, result, actor.name, notes, reviewedAt, rejectedQuantity ?? undefined);
        let finishingCompleted = false;
        if (completeFinishing) {
          const finished = plan.forceCompleteFinishing(requirementId, actor);
          if (finished) { requirementStatus = finished.requirementStatus; finishingCompleted = true; }
        }
        return {
          requirementId,
          result,
          notes,
          rejectedQuantity,
          finishingCompleted,
          notificationContext: {
            ...notificationPartContext(state, requirementId),
            previousRequirementStatus: String(requirement(state, requirementId).status ?? "Needs Triage"),
            requirementStatus,
            postQcWorkReady: releasesPostQcWork(state, plan),
          },
        };
      }, (_state, review) => ({
        requirement_id: requirementId,
        result,
        notes,
        ...(review.rejectedQuantity === null ? {} : { rejected_quantity: review.rejectedQuantity }),
        reviewed_at: reviewedAt,
        location: null,
      }));
    },
    /** Every QC review and retraction. One RPC value, so PostgREST's max_rows never truncates it. */
    async qualityReviews() {
      const { reviews, retractions } = await rpc<WriteState>("manufacturing_write_state");
      return { reviews, retractedIds: retractions.map(row => row.review_id) };
    },
    applyQuantityAction(id: number, action: OperationQuantityAction, quantity: number, actor: Actor, handoff?: { programPath?: string; notes?: string; location?: StorageLocation; completeAllClaims?: boolean }) {
      return transact(actor, action, (plan, state) => {
        const row = operation(state, id);
        const printing = isPrintingOperation({ machine: String(row.machine ?? ""), workType: String(row.work_type ?? "Manufacturing") });
        if (handoff?.completeAllClaims && (action !== "complete" || !printing)) {
          throw new ManufacturingWriteError("Only 3D printing claims can be completed on behalf of other users", 400);
        }
        if (handoff?.location !== undefined) {
          if (!isStorageLocation(handoff.location)) throw new ManufacturingWriteError("Invalid storage location", 400);
          if (row.work_type === "CAM" || !(action === "complete" || action === "claim" && printing)) {
            throw new ManufacturingWriteError("Set a location when claiming printed parts or completing manufacturing work", 400);
          }
          if (handoff.location === ROBOT_LOCATION) throw new ManufacturingWriteError("Move parts onto the robot separately after QC and finishing", 409);
        }
        if (afterQc(state, row) && ["claim", "complete"].includes(action)) {
          assertEffectivePassedReview(state, Number(row.requirement_id), "Work after QC requires a current passed QC review");
        }
        const result = plan.applyQuantityAction(id, action, quantity, actor, handoff);
        return { ...result, notificationContext: { ...result.notificationContext, postQcWorkReady: releasesPostQcWork(state, plan) }, ...(handoff?.location === undefined ? {} : {
          storageLocation: handoff.location,
          locationUpdatedBy: actor.name,
          locationUpdatedAt: new Date().toISOString(),
        }) };
      }, null, handoff?.location === undefined ? "manufacturing_commit_with_qc_quantities" : "manufacturing_commit_with_operation_location");
    },
    stealOperationClaim(id: number, actor: Actor) {
      return transact(actor, "steal", (plan, state) => {
        const row = operation(state, id);
        if (afterQc(state, row)) {
          assertEffectivePassedReview(state, Number(row.requirement_id), "Work after QC requires a current passed QC review");
        }
        return plan.stealOperationClaim(id, actor);
      });
    },
    patchOperation(id: number, patch: OperationPatch, actor: Actor) {
      return transact(actor, "patch_operation", (plan, state) => {
        const row = operation(state, id);
        const requirement = state.rows.requirements.find(r => r.id === row.requirement_id);
        if (requirement?.qc_outcome === "Passed" && !afterQc(state, row)) {
          throw new ManufacturingWriteError("Undo the passed QC review before editing completed work", 409);
        }
        if (patch.status === "Complete" || patch.status === "In Progress" || row.status === "Complete" && patch.status !== undefined) {
          throw new ManufacturingWriteError("Use quantity actions to claim, complete, or reopen work", 409);
        }
        if (row.work_type === "CAM" && row.status === "Complete") throw new ManufacturingWriteError("Use undo completion to reopen CAM", 409);
        if (Number(row.claimed_quantity ?? 0) + Number(row.completed_quantity ?? 0) > 0 && ["Planned", "Ready"].includes(patch.status ?? "")) {
          throw new ManufacturingWriteError("Release or undo allocated work before resetting its status", 409);
        }
        return plan.patchOperation(id, patch);
      });
    },
    updateCamHandoff(id: number, patch: { completedBy: string; programPath: string; notes: string }, actor: Actor) {
      return transact(actor, "cam_handoff", (plan, state) => { operation(state, id); return plan.updateCamHandoff(id, patch); });
    },
    applyFabricationAction(id: number, action: FabricationAction, actor: Actor) {
      return transact(actor, action === "steal" ? "steal" : `finishing_${action}`, (plan, state) => {
        const finishing = state.rows.finishing.find((candidate) => candidate.id === id);
        if (!finishing?.active) throw new ManufacturingWriteError("This finishing job is no longer active", 409);
        const requirementRow = assertWorkAllowed(state, Number(finishing.requirement_id));
        if (action === "undo_complete" && requirementRow.part_location === ROBOT_LOCATION) {
          throw new ManufacturingWriteError("Move the part off the robot before reopening finishing", 409);
        }
        const result = plan.applyFabricationAction(id, action, actor);
        return { ...result, notificationContext: { ...result.notificationContext, postQcWorkReady: releasesPostQcWork(state, plan) } };
      });
    },
    renameMachinistAllocations(userId: string, oldName: string, newName: string) {
      return transact({ id: userId, name: newName }, "rename", plan => plan.renameMachinistAllocations(userId, oldName, newName));
    },
    recordQualityReview(
      requirementId: number,
      result: Exclude<QualityResult, "pending">,
      notes: string,
      actor: Actor,
      location: StorageLocation | null = null,
      rejectedQuantity?: number,
    ) {
      if (location !== null && !isStorageLocation(location)) throw new ManufacturingWriteError("Invalid storage location", 400);
      if (result === "failed" && location !== null) throw new ManufacturingWriteError("A failed QC review cannot assign a storage location", 400);
      if (result === "failed" && !notes.trim()) throw new ManufacturingWriteError("Enter a reason for the QC failure", 400);
      if (location === ROBOT_LOCATION) throw new ManufacturingWriteError("On Robot becomes available after QC passes and finishing is complete", 409);
      const reviewedAt = new Date().toISOString();
      return transact(actor, "qc_review", (plan, state) => {
        const requirementRow = assertWorkAllowed(state, requirementId);
        // A second review (e.g. from a stale page) would leave released post-QC work in place.
        if (hasCurrentPass(state, requirementId)) {
          throw new ManufacturingWriteError("This part already passed QC. Undo the pass before reviewing it again.", 409);
        }
        const maximumQuantity = Math.max(1, Math.floor(Number(requirementRow.required_quantity ?? 1)));
        const effectiveRejectedQuantity = result === "failed" ? rejectedQuantity ?? maximumQuantity : null;
        if (result === "failed") {
          const quantity = effectiveRejectedQuantity;
          if (typeof quantity !== "number" || !Number.isInteger(quantity)
            || quantity < 1 || quantity > maximumQuantity) {
            throw new ManufacturingWriteError(`Rejected quantity must be a whole number from 1 to ${maximumQuantity}`, 400);
          }
        }
        const requirementStatus = plan.patchRequirementQualityOutcome(
          requirementId,
          result,
          actor.name,
          notes,
          reviewedAt,
          effectiveRejectedQuantity ?? undefined,
        );
        return {
          requirementId,
          result,
          notes,
          rejectedQuantity: effectiveRejectedQuantity,
          storageLocation: result === "passed" ? location : null,
          locationUpdatedBy: result === "passed" && location ? actor.name : null,
          locationUpdatedAt: result === "passed" && location ? reviewedAt : null,
          notificationContext: {
            ...notificationPartContext(state, requirementId),
            previousRequirementStatus: String(requirement(state, requirementId).status ?? "Needs Triage"),
            requirementStatus,
            postQcWorkReady: releasesPostQcWork(state, plan),
          },
        };
      }, (_state, review) => ({
        requirement_id: requirementId,
        result,
        notes,
        ...(review.rejectedQuantity === null ? {} : { rejected_quantity: review.rejectedQuantity }),
        reviewed_at: reviewedAt,
        location: result === "passed" ? location : null,
      }));
    },
    async updateRequirementNotes(requirementId: number, notes: string, actor: Actor) {
      if (!UUID_PATTERN.test(actor.id) || !actor.name.trim()) throw new ManufacturingWriteError("An authenticated manufacturing actor is required", 401);
      const state = await rpc<WriteState>("manufacturing_write_state");
      requirement(state, requirementId);
      const body = {
        p_request_id: crypto.randomUUID(),
        p_actor: actor.id,
        p_expected: state.token,
        p_requirement_id: requirementId,
        p_notes: notes,
        p_result: { requirementId, productionNotes: notes },
      };
      try { return await rpc<{ requirementId: number; productionNotes: string }>("manufacturing_update_requirement_notes", body); }
      catch (error) { if (error instanceof ManufacturingWriteError) throw error; return rpc<{ requirementId: number; productionNotes: string }>("manufacturing_update_requirement_notes", body); }
    },
    async setRequirementObsolete(requirementId: number, obsolete: boolean, expectedVersion: number, actor: Actor) {
      if (!UUID_PATTERN.test(actor.id) || !actor.name.trim()) throw new ManufacturingWriteError("An authenticated manufacturing actor is required", 401);
      const state = await rpc<WriteState>("manufacturing_write_state");
      const row = requirement(state, requirementId);
      if (Number(row.obsoletion_version ?? 0) !== expectedVersion) {
        throw new ManufacturingWriteError("Obsoletion changed. Refresh before trying again.", 409);
      }
      const body = { p_request_id: crypto.randomUUID(), p_actor: actor.id, p_expected: state.token,
        p_requirement_id: requirementId, p_obsolete: obsolete, p_version: expectedVersion };
      type Result = { requirementId: number; obsolete: boolean; obsoletionVersion: number };
      const reader = createSupabaseManufacturingAdapter(config);
      const [parts, assemblies] = await Promise.all([
        state.rows.parts ?? reader.readEntity("parts"),
        state.rows.assemblies ?? reader.readEntity("assemblies"),
      ]);
      const notificationContext = {
        ...notificationPartContext({ ...state, rows: { ...state.rows, parts, assemblies } }, requirementId),
        previousObsolete: Boolean(row.obsolete),
        revision: String(row.required_part_revision ?? ""),
        location: row.part_location == null ? null : String(row.part_location),
      };
      let result: Result;
      try { result = await rpc<Result>("manufacturing_set_requirement_obsolete", body); }
      catch (error) { if (error instanceof ManufacturingWriteError) throw error; result = await rpc<Result>("manufacturing_set_requirement_obsolete", body); }
      return { ...result, notificationContext };
    },
    async setRequirementHidden(requirementId: number, hidden: boolean, expectedVersion: number, actor: Actor) {
      if (!UUID_PATTERN.test(actor.id) || !actor.name.trim()) throw new ManufacturingWriteError("An authenticated manufacturing actor is required", 401);
      const state = await rpc<WriteState>("manufacturing_write_state");
      const row = requirement(state, requirementId);
      if (Number(row.visibility_version ?? 0) !== expectedVersion) throw new ManufacturingWriteError("Visibility changed. Refresh before trying again.", 409);
      if (hidden && !row.obsolete) throw new ManufacturingWriteError("Only obsolete requirements can be hidden", 409);
      const body = { p_request_id: crypto.randomUUID(), p_actor: actor.id, p_expected: state.token,
        p_requirement_id: requirementId, p_hidden: hidden, p_version: expectedVersion };
      type Result = { requirementId: number; hidden: boolean; visibilityVersion: number };
      try { return await rpc<Result>("manufacturing_set_requirement_hidden", body); }
      catch (error) { if (error instanceof ManufacturingWriteError) throw error; return rpc<Result>("manufacturing_set_requirement_hidden", body); }
    },
    readEngineeringOverrideState(requirementId: number) {
      return rpc<EngineeringOverrideState>("manufacturing_engineering_override_state", { p_requirement_id: requirementId });
    },
    readRequirementHistory(requirementId: number) {
      return rpc<RequirementHistoryPayload | null>("manufacturing_requirement_history", { p_requirement_id: requirementId });
    },
    readEngineeringCorrections() {
      return rpc<EngineeringCorrection[]>("manufacturing_engineering_correction_list", {});
    },
    async applyEngineeringOverrides(requirementId: number, fields: EngineeringOverrideFields, expectedToken: string, reason: string, actor: Actor) {
      if (!UUID_PATTERN.test(actor.id) || !actor.name.trim()) throw new ManufacturingWriteError("An authenticated manufacturing actor is required", 401);
      const [state, overrideState] = await Promise.all([
        rpc<WriteState>("manufacturing_write_state"),
        rpc<EngineeringOverrideState>("manufacturing_engineering_override_state", { p_requirement_id: requirementId }),
      ]);
      if (overrideState.token !== expectedToken) throw new ManufacturingWriteError(STALE_OVERRIDE_MESSAGE, 409);
      const rows = await withIdentityRows(state);
      let plan: ReturnType<typeof planEngineeringOverrides>;
      try { plan = planEngineeringOverrides({ rows, state: overrideState, requirementId, fields, actor }); }
      catch (error) {
        if (error instanceof EngineeringOverrideError) throw new ManufacturingWriteError(error.message, error.status);
        throw error;
      }
      if (!plan.overrides.length && !plan.changes.length && !plan.inserts.length) throw new ManufacturingWriteError("Nothing to change", 400);
      const result = {
        requirementId,
        changes: plan.summary,
        requirementStatus: plan.requirementStatus,
        notificationContext: {
          ...notificationPartContext({ ...state, rows }, requirementId),
          ...(plan.partName ? { partName: plan.partName } : {}),
          routingChanged: plan.routingChanged,
        },
      };
      const body = { p_request_id: crypto.randomUUID(), p_actor: actor.id, p_expected: state.token, p_override_token: overrideState.token,
        p_requirement_id: requirementId, p_overrides: plan.overrides, p_changes: plan.changes, p_inserts: plan.inserts,
        p_reason: reason.trim(), p_result: result };
      try { return await rpc<typeof result>("manufacturing_apply_engineering_overrides", body); }
      catch (error) { if (error instanceof ManufacturingWriteError) throw error; return rpc<typeof result>("manufacturing_apply_engineering_overrides", body); }
    },
    async setAttachmentOverride(requirementId: number, kind: OverrideFileKind, file: { name: string; sha256: string; byteSize: number } | null,
      expectedToken: string, reason: string, actor: Actor) {
      if (!UUID_PATTERN.test(actor.id) || !actor.name.trim()) throw new ManufacturingWriteError("An authenticated manufacturing actor is required", 401);
      const state = await rpc<WriteState>("manufacturing_write_state");
      const rows = await withIdentityRows(state);
      requirement(state, requirementId);
      const body = { p_request_id: crypto.randomUUID(), p_actor: actor.id, p_override_token: expectedToken, p_requirement_id: requirementId,
        p_kind: kind, p_file: file && { original_name: file.name, sha256: file.sha256, byte_size: file.byteSize }, p_reason: reason.trim() };
      type Result = { requirementId: number; kind: OverrideFileKind; file: { name: string; sha256: string; byte_size: number } | null };
      let result: Result;
      try { result = await rpc<Result>("manufacturing_set_attachment_override", body); }
      catch (error) { if (error instanceof ManufacturingWriteError) throw error; result = await rpc<Result>("manufacturing_set_attachment_override", body); }
      return { ...result, notificationContext: notificationPartContext({ ...state, rows }, requirementId) };
    },
    updatePassedQualityNotes(requirementId: number, notes: string, actor: Actor) {
      const reviewedAt = new Date().toISOString();
      return transact(actor, "qc_review", (plan, state) => {
        assertEffectivePassedReview(state, requirementId, "Only a current passed QC review can have its inspection notes updated");
        plan.patchRequirementQualityNote(requirementId, actor.name, notes, reviewedAt);
        return {
          requirementId,
          result: "passed" as const,
          notes,
          reviewedAt,
          reviewedBy: actor.name,
        };
      }, { requirement_id: requirementId, result: "passed", notes, reviewed_at: reviewedAt, location: null });
    },
    updatePartLocation(requirementId: number, location: StorageLocation | null, actor: Actor) {
      if (location !== null && !isStorageLocation(location)) throw new ManufacturingWriteError("Invalid storage location", 400);
      const updatedAt = new Date().toISOString();
      return transact(actor, "part_location", (_plan, state) => {
        const requirementRow = requirement(state, requirementId);
        const finishingRequired = Boolean(requirementRow.finishing && requirementRow.finishing !== "None");
        const finishingComplete = isFinishingComplete({
          finishingRequired, qcPassed: requirementRow.qc_outcome === "Passed", status: String(requirementRow.status ?? ""),
        });
        if (location === ROBOT_LOCATION) {
          if (requirementRow.obsolete) throw new ManufacturingWriteError("This requirement is obsolete. Do not manufacture or install it.", 409);
          if (!robotPlacementAllowed({ activeInBom: Boolean(requirementRow.active_in_bom), obsoletionVersion: Number(requirementRow.obsoletion_version ?? 0) })) {
            throw new ManufacturingWriteError("This requirement is inactive in the BOM", 409);
          }
          assertEffectivePassedReview(state, requirementId, "On Robot requires a current passed QC review");
          if (!finishingComplete) {
            throw new ManufacturingWriteError("Complete finishing before moving this part onto the robot", 409);
          }
        }
        return {
          storageLocation: location,
          locationUpdatedBy: actor.name,
          locationUpdatedAt: updatedAt,
          notificationContext: {
            ...notificationPartContext(state, requirementId),
            previousLocation: isStorageLocation(requirementRow.part_location) ? requirementRow.part_location : null,
          },
        };
      }, { requirement_id: requirementId, location, location_updated_at: updatedAt });
    },
    undoQualityReview(requirementId: number, actor: Actor) {
      return transact(actor, "qc_undo", (plan, state) => {
        assertWorkAllowed(state, requirementId);
        if (requirement(state, requirementId).part_location === ROBOT_LOCATION) {
          throw new ManufacturingWriteError("Move the part off the robot before undoing QC", 409);
        }
        const review = latestReview(state, requirementId);
        if (!review || review.result !== "passed" || state.retractions.some(r => r.review_id === review.id)) throw new ManufacturingWriteError("Only the latest passed QC review can be undone", 409);
        plan.clearPassedRequirementQualityOutcome(requirementId);
        return {
          undone: true,
          requirementId,
          notificationContext: notificationPartContext(state, requirementId),
        };
      }, { requirement_id: requirementId });
    },
  };
}
