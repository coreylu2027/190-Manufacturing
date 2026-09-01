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
export type UserRole = "machinist" | "admin";

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
  user: { id: string; name: string; email: string | null; role: UserRole; approved: boolean } | null;
}

export interface OperationPatch {
  status?: OperationStatus;
  machinist?: string;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  approved: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

export type QualityResult = "pending" | "passed" | "failed";

export interface QualityControlItem {
  operation: ManufacturingOperation;
  result: QualityResult;
  notes: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface AdminResponse {
  users: AdminUserSummary[];
  qualityControl: QualityControlItem[];
  source: DataSource;
}
