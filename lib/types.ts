export const OPERATION_STATUSES = [
  "Planned",
  "Ready",
  "In Progress",
  "Blocked",
  "Needs Rework",
  "Complete",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export type DataSource = "baserow" | "demo";

export interface ManufacturingOperation {
  id: number;
  operationKey: string;
  partNumber: string;
  partName: string;
  assemblyNumber: string;
  quantity: number;
  operationNumber: "OP1" | "OP2" | "OP3" | "OP4";
  machine: string;
  status: OperationStatus;
  machinist: string;
  startedAt: string | null;
  completedAt: string | null;
  activeInRouting: boolean;
  drawingUrl: string | null;
  drawingPdfUrl: string | null;
  stepUrl: string | null;
  onshapeUrl: string | null;
}

export interface OperationsResponse {
  operations: ManufacturingOperation[];
  source: DataSource;
  syncedAt: string;
  user: { name: string; email: string | null } | null;
}

export interface OperationPatch {
  status?: OperationStatus;
  machinist?: string;
}
