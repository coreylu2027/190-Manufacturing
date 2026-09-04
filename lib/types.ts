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
export type OperationWorkType = "Manufacturing" | "CAM";
export type OperationQuantityAction = "claim" | "release" | "complete" | "undo_complete";
export type OperationAction = OperationQuantityAction | "steal";
export type FabricationAction = "claim" | "release" | "complete" | "undo_complete";

export interface OperationAllocation {
  userId: string;
  name: string;
  claimed: number;
  completed: number;
}

export interface CamDependency {
  operationId: number;
  status: OperationStatus;
  completedBy: string;
  programPath: string | null;
  notes: string;
}

export interface ManufacturingOperation {
  id: number;
  operationKey: string;
  partNumber: string;
  revision: string | null;
  partName: string;
  assemblyNumber: string;
  documentName: string | null;
  material: string | null;
  quantity: number;
  taskQuantity: number;
  claimedQuantity: number;
  completedQuantity: number;
  availableQuantity: number;
  allocations: OperationAllocation[];
  operationNumber: "OP1" | "OP2" | "OP3" | "OP4";
  workType: OperationWorkType;
  machine: string;
  status: OperationStatus;
  machinist: string;
  startedAt: string | null;
  completedAt: string | null;
  activeInRouting: boolean;
  camProgramPath: string | null;
  camNotes: string;
  camDependency: CamDependency | null;
  drawingUrl: string | null;
  drawingPdfUrl: string | null;
  drawingPdfName: string | null;
  stepUrl: string | null;
  stepName: string | null;
  onshapeUrl: string | null;
}

export interface OperationsResponse {
  operations: ManufacturingOperation[];
  source: DataSource;
  syncedAt: string;
  user: { id: string; name: string; email: string | null; role: UserRole; approved: boolean } | null;
}

export interface FabricationJob {
  id: number;
  productionKey: string;
  requirementId: number;
  partNumber: string;
  partName: string;
  assemblyNumber: string;
  documentName: string | null;
  quantity: number;
  color: string;
  qcNotes: string;
  status: OperationStatus;
  requirementStatus: string;
  machinist: string;
  active: boolean;
  lastSyncedAt: string | null;
  drawingUrl: string | null;
  drawingPdfUrl: string | null;
  drawingPdfName: string | null;
  stepUrl: string | null;
  stepName: string | null;
  onshapeUrl: string | null;
}

export interface FabricationResponse {
  jobs: FabricationJob[];
  source: DataSource;
  syncedAt: string;
  user: OperationsResponse["user"];
}

export interface FabricationActionPatch {
  action: FabricationAction;
}

export interface OperationPatch {
  status?: OperationStatus;
  machinist?: string;
}

export interface OperationQuantityPatch {
  action: OperationQuantityAction;
  quantity: number;
  programPath?: string;
  notes?: string;
}

export interface OperationStealPatch {
  action: "steal";
  confirmed: true;
}

export interface CamHandoffPatch {
  action: "edit_cam_handoff";
  completedBy: string;
  programPath: string;
  notes: string;
}

export type OperationActionPatch = OperationQuantityPatch | OperationStealPatch;

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  approved: boolean;
  createdAt: string;
  lastSeenAt: string | null;
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
