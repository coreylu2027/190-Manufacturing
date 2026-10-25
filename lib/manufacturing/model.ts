export interface ManufacturingAttachment {
  partId: number;
  kind: "drawing-pdf" | "step";
  position: number;
  originalName: string;
}
export type NormalizedRow = Record<string, unknown> & { id: number };

/** The columns a shop write may change, as manufacturing_commit allows them, with how each is stored. */
export const SHOP_COLUMNS = {
  requirements: {
    status: "select", machinist: "text", qc_outcome: "select", qc_notes: "text", qc_reviewed_by: "text",
    qc_reviewed_at: "text", disposition: "select",
  },
  operations: {
    status: "select", machinist: "text", started_at: "text", completed_at: "text", claimed_quantity: "number",
    completed_quantity: "number", quantity_ledger: "text", cam_program_path: "text", cam_notes: "text",
  },
  finishing: { machinist: "text" },
} as const;
export type ShopEntity = keyof typeof SHOP_COLUMNS;

/** A shop column value as committed: empty text and dates are null, and quantities are numbers. */
export function shopColumnValue(value: unknown, kind: "text" | "select" | "number"): unknown {
  if (value === undefined || value === null) return null;
  if (kind === "select") return value;
  if (value === "") return null;
  if (kind !== "number") return value;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Non-finite source quantity");
  return number;
}
