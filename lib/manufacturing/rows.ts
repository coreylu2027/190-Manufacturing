// Column accessors and quantity-ledger math shared by the read projections and the write planner.
import type { ManufacturingOperation, OperationAllocation, OperationStatus, OperationWorkType } from "../types.ts";
import type { NormalizedRow } from "./model.ts";

export function selectValue(value: unknown, fallback = ""): string {
  return value == null ? fallback : String(value);
}

export function linkedId(value: unknown): number | null {
  return value == null ? null : Number(value);
}

export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function operationWorkType(row: NormalizedRow): OperationWorkType {
  return selectValue(row.work_type, "Manufacturing") === "CAM" ? "CAM" : "Manufacturing";
}

/** CAM is one task however many parts the requirement needs. */
export function taskQuantityForRow(row: NormalizedRow, requiredQuantity: number) {
  return operationWorkType(row) === "CAM" ? 1 : requiredQuantity;
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

/** Writes refuse to build on a ledger that reads would silently repair. */
export function assertValidLedger(row: NormalizedRow) {
  const rawLedger = row.quantity_ledger;
  if (typeof rawLedger !== "string" || !rawLedger.trim()) return;
  let ledger: unknown = null;
  try { ledger = JSON.parse(rawLedger); } catch { /* reported as invalid below */ }
  if (!Array.isArray(ledger) || ledger.some(a => !a || !a.userId || !a.name ||
    !Number.isSafeInteger(a.claimed) || a.claimed < 0 || !Number.isSafeInteger(a.completed) || a.completed < 0)) {
    throw new Error("Invalid existing quantity ledger; reconciliation is required before editing");
  }
}

/** The per-person claims on a row; rows without a ledger are attributed to their legacy machinist. */
export function quantitiesForRow(row: NormalizedRow, requiredQuantity: number, status: OperationStatus) {
  let allocations = parseQuantityLedger(row.quantity_ledger);
  const hasStoredClaimed = row.claimed_quantity != null && row.claimed_quantity !== "";
  const hasStoredCompleted = row.completed_quantity != null && row.completed_quantity !== "";
  const storedClaimed = Number(row.claimed_quantity);
  const storedCompleted = Number(row.completed_quantity);
  const claimedFallback = hasStoredClaimed && Number.isFinite(storedClaimed)
    ? Math.max(0, Math.floor(storedClaimed))
    : status === "In Progress" ? requiredQuantity : 0;
  const completedFallback = hasStoredCompleted && Number.isFinite(storedCompleted)
    ? Math.max(0, Math.floor(storedCompleted))
    : status === "Complete" ? requiredQuantity : 0;

  if (allocations.length === 0 && (claimedFallback > 0 || completedFallback > 0)) {
    const legacyName = String(row.machinist ?? "").trim() || "Legacy assignment";
    allocations = [{
      userId: `legacy:${legacyName.toLocaleLowerCase()}`,
      name: legacyName,
      claimed: claimedFallback,
      completed: completedFallback,
    }];
  }

  const claimedQuantity = allocations.reduce((sum, allocation) => sum + allocation.claimed, 0);
  const completedQuantity = allocations.reduce((sum, allocation) => sum + allocation.completed, 0);
  const canClaim = ["Ready", "In Progress"].includes(status);
  return {
    allocations,
    claimedQuantity,
    completedQuantity,
    availableQuantity: canClaim ? Math.max(0, requiredQuantity - claimedQuantity - completedQuantity) : 0,
  };
}

export function fabricationStatus(requirementStatus: string, machinist: string): ManufacturingOperation["status"] {
  if (requirementStatus === "Complete") return "Complete";
  if (requirementStatus === "Ready for Finishing") return machinist ? "In Progress" : "Ready";
  return "Planned";
}
