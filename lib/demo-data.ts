import type { FabricationJob, ManufacturingOperation } from "@/lib/types";

const shared = {
  requirementId: null,
  revision: "A",
  activeInRouting: true,
  claimedQuantity: 0,
  completedQuantity: 0,
  availableQuantity: 0,
  allocations: [] as ManufacturingOperation["allocations"],
  drawingUrl: "https://frc190.onshape.com",
  drawingPdfUrl: null,
  drawingPdfName: null,
  stepUrl: null,
  stepName: null,
  onshapeUrl: "https://frc190.onshape.com",
  documentName: "A-26C-0001",
  material: "6061-T6 Aluminum",
  taskQuantity: 0,
  workType: "Manufacturing" as const,
  machinist: "",
  startedAt: null,
  completedAt: null,
  camProgramPath: null,
  camNotes: "",
  camDependency: null,
} as const;

const DEMO_OPERATION_ROWS: ManufacturingOperation[] = [
  { ...shared, id: 1, operationKey: "P-190B-261036|OP1", partNumber: "P-190B-261036", partName: "Inner Race", assemblyNumber: "A-190B-261032", quantity: 2, operationNumber: "OP1", machine: "Bambu 3D Printer", status: "Ready" },
  { ...shared, id: 2, operationKey: "P-190B-261037|OP1", partNumber: "P-190B-261037", partName: "Outer Race", assemblyNumber: "A-190B-261032", quantity: 2, operationNumber: "OP1", machine: "Bambu 3D Printer", status: "Ready" },
  { ...shared, id: 3, operationKey: "P-190B-261042|OP1", partNumber: "P-190B-261042", partName: "Roller Tube", assemblyNumber: "A-190B-261032", quantity: 1, operationNumber: "OP1", machine: "Bandsaw", status: "Ready" },
  { ...shared, id: 4, operationKey: "P-190B-261042|OP2", partNumber: "P-190B-261042", partName: "Roller Tube", assemblyNumber: "A-190B-261032", quantity: 1, operationNumber: "OP2", machine: "Guided Drilling", status: "Planned" },
  { ...shared, id: 5, operationKey: "P-190B-260624|OP1", partNumber: "P-190B-260624", partName: '1/2\" Hex (2.15 in)', assemblyNumber: "A-190B-261131", quantity: 3, operationNumber: "OP1", machine: "Lathe", status: "Ready" },
  { ...shared, id: 6, operationKey: "P-190B-260624|OP2", partNumber: "P-190B-260624", partName: '1/2\" Hex (2.15 in)', assemblyNumber: "A-190B-261131", quantity: 3, operationNumber: "OP2", machine: "Tapping", status: "Planned" },
  { ...shared, id: 7, operationKey: "P-190B-260723|OP1", partNumber: "P-190B-260723", partName: '1/2\" Rounded Hex (25.875 in)', assemblyNumber: "A-190B-261131", quantity: 1, operationNumber: "OP1", machine: "Lathe", status: "Ready" },
  { ...shared, id: 8, operationKey: "P-190B-260723|OP2", partNumber: "P-190B-260723", partName: '1/2\" Rounded Hex (25.875 in)', assemblyNumber: "A-190B-261131", quantity: 1, operationNumber: "OP2", machine: "Tapping", status: "Planned" },
  { ...shared, id: 9, operationKey: "P-190B-260646|OP1", partNumber: "P-190B-260646", partName: "Top Hood Roller", assemblyNumber: "A-190B-261131", quantity: 2, operationNumber: "OP1", machine: "Bandsaw", status: "Ready" },
  { ...shared, id: 10, operationKey: "P-190B-260646|OP2", partNumber: "P-190B-260646", partName: "Top Hood Roller", assemblyNumber: "A-190B-261131", quantity: 2, operationNumber: "OP2", machine: "Guided Drilling", status: "Planned" },
  { ...shared, id: 11, operationKey: "P-190B-260650|OP1", partNumber: "P-190B-260650", partName: "Flywheel", assemblyNumber: "A-190B-261131", quantity: 2, operationNumber: "OP1", machine: "Bandsaw", status: "Ready" },
  { ...shared, id: 12, operationKey: "P-190B-260650|OP2", partNumber: "P-190B-260650", partName: "Flywheel", assemblyNumber: "A-190B-261131", quantity: 2, operationNumber: "OP2", machine: "Haas CNC", status: "Planned" },
  { ...shared, id: 13, operationKey: "P-190B-260621|OP1", partNumber: "P-190B-260621", partName: "Inner Kicker Arm Plate — Right", assemblyNumber: "A-190B-261061", quantity: 1, operationNumber: "OP1", machine: "Shop Sabre CNC", status: "Blocked" },
  { ...shared, id: 14, operationKey: "P-190B-260629|OP1", partNumber: "P-190B-260629", partName: "Second Kicker Shaft", assemblyNumber: "A-190B-261061", quantity: 1, operationNumber: "OP1", machine: "Lathe", status: "Needs Rework" },
  { ...shared, id: 15, operationKey: "P-190B-260633|OP1", partNumber: "P-190B-260633", partName: "Kicker Gearbox Plate A", assemblyNumber: "A-190B-261061", quantity: 1, operationNumber: "OP1", machine: "Haas CNC", status: "In Progress", machinist: "Demo Machinist", startedAt: "2026-09-01T13:42:00.000Z" },
  { ...shared, id: 16, operationKey: "P-190B-260640|OP1", partNumber: "P-190B-260640", partName: "Completed QC Sample", assemblyNumber: "A-190B-261061", quantity: 1, operationNumber: "OP1", machine: "Haas CNC", status: "Complete", machinist: "Demo Machinist", startedAt: "2026-09-01T12:15:00.000Z", completedAt: "2026-09-01T13:05:00.000Z" },
  { ...shared, id: 17, operationKey: "P-190B-260650|OP2|CAM", partNumber: "P-190B-260650", partName: "Flywheel", assemblyNumber: "A-190B-261131", quantity: 2, operationNumber: "OP2", workType: "CAM", machine: "Haas CNC", status: "Ready" },
  { ...shared, id: 18, operationKey: "P-190B-260621|OP1|CAM", partNumber: "P-190B-260621", partName: "Inner Kicker Arm Plate — Right", assemblyNumber: "A-190B-261061", quantity: 1, operationNumber: "OP1", workType: "CAM", machine: "Shop Sabre CNC", status: "Ready" },
  { ...shared, id: 19, operationKey: "P-190B-260633|OP1|CAM", partNumber: "P-190B-260633", partName: "Kicker Gearbox Plate A", assemblyNumber: "A-190B-261061", quantity: 1, operationNumber: "OP1", workType: "CAM", machine: "Haas CNC", status: "Ready" },
  { ...shared, id: 20, operationKey: "P-190B-260640|OP1|CAM", partNumber: "P-190B-260640", partName: "Completed QC Sample", assemblyNumber: "A-190B-261061", quantity: 1, operationNumber: "OP1", workType: "CAM", machine: "Haas CNC", status: "Ready" },
];

const DEMO_OPERATIONS_WITH_QUANTITIES: ManufacturingOperation[] = DEMO_OPERATION_ROWS.map((operation) => {
  const matchingRequirementIndex = DEMO_OPERATION_ROWS.findIndex((candidate) =>
    candidate.assemblyNumber === operation.assemblyNumber && candidate.partNumber === operation.partNumber,
  );
  const requirementId = 1000 + matchingRequirementIndex;
  const taskQuantity = operation.workType === "CAM" ? 1 : operation.quantity;
  if (operation.status === "Complete") {
    return {
      ...operation,
      requirementId,
      taskQuantity,
      completedQuantity: taskQuantity,
      allocations: [{ userId: "demo-admin", name: "Demo M.", claimed: 0, completed: taskQuantity }],
      machinist: "Demo M.",
    };
  }
  if (operation.status === "In Progress") {
    return {
      ...operation,
      requirementId,
      taskQuantity,
      claimedQuantity: taskQuantity,
      allocations: [{ userId: "demo-machinist", name: "Demo M.", claimed: taskQuantity, completed: 0 }],
      machinist: "Demo M.",
    };
  }
  return { ...operation, requirementId, taskQuantity, availableQuantity: operation.status === "Ready" ? taskQuantity : 0 };
});

export const DEMO_OPERATIONS: ManufacturingOperation[] = DEMO_OPERATIONS_WITH_QUANTITIES.map((operation) => {
  if (operation.workType !== "Manufacturing") return operation;
  const cam = DEMO_OPERATIONS_WITH_QUANTITIES.find((candidate) =>
    candidate.workType === "CAM"
    && candidate.assemblyNumber === operation.assemblyNumber
    && candidate.partNumber === operation.partNumber
    && candidate.operationNumber === operation.operationNumber,
  );
  return cam ? {
    ...operation,
    camDependency: {
      operationId: cam.id,
      status: cam.status,
      completedBy: cam.machinist,
      programPath: cam.camProgramPath,
      notes: cam.camNotes,
    },
  } : operation;
});

export const DEMO_FABRICATION_JOBS: FabricationJob[] = [
  {
    id: 101,
    productionKey: "A-190B-261131|P-190B-260677|default",
    requirementId: 465,
    partNumber: "P-190B-260677",
    partName: "Shooter Motor Support Plate",
    assemblyNumber: "A-190B-261131",
    documentName: "A-26C-0001",
    quantity: 1,
    color: "Red",
    qcNotes: "Dimensions checked against drawing; ready for red powder coat.",
    status: "Ready",
    requirementStatus: "Ready for Finishing",
    machinist: "",
    active: true,
    lastSyncedAt: "2026-09-01T12:00:00.000Z",
    drawingUrl: "https://frc190.onshape.com",
    drawingPdfUrl: null,
    drawingPdfName: null,
    stepUrl: null,
    stepName: null,
    onshapeUrl: "https://frc190.onshape.com",
  },
  {
    id: 102,
    productionKey: "A-190B-261131|P-190B-260696|default",
    requirementId: 497,
    partNumber: "P-190B-260696",
    partName: "Inertia Wheel",
    assemblyNumber: "A-190B-261131",
    documentName: "A-26C-0001",
    quantity: 1,
    color: "Black",
    qcNotes: "Fit and hole locations verified.",
    status: "In Progress",
    requirementStatus: "Ready for Finishing",
    machinist: "Demo A.",
    active: true,
    lastSyncedAt: "2026-09-01T12:00:00.000Z",
    drawingUrl: "https://frc190.onshape.com",
    drawingPdfUrl: null,
    drawingPdfName: null,
    stepUrl: null,
    stepName: null,
    onshapeUrl: "https://frc190.onshape.com",
  },
  {
    id: 103,
    productionKey: "A-190B-261131|P-190B-260690|default",
    requirementId: 468,
    partNumber: "P-190B-260690",
    partName: "ROUND Spacer 1.406 in",
    assemblyNumber: "A-190B-261131",
    documentName: "A-26C-0001",
    quantity: 12,
    color: "Black",
    qcNotes: "",
    status: "Planned",
    requirementStatus: "Ready for QC",
    machinist: "",
    active: true,
    lastSyncedAt: "2026-09-01T12:00:00.000Z",
    drawingUrl: "https://frc190.onshape.com",
    drawingPdfUrl: null,
    drawingPdfName: null,
    stepUrl: null,
    stepName: null,
    onshapeUrl: "https://frc190.onshape.com",
  },
  {
    id: 104,
    productionKey: "A-190B-261131|P-190B-260715|default",
    requirementId: 446,
    partNumber: "P-190B-260715",
    partName: "Right Pulley Support Plate",
    assemblyNumber: "A-190B-261131",
    documentName: "A-26C-0001",
    quantity: 1,
    color: "Black",
    qcNotes: "Inspection complete; no defects found.",
    status: "Complete",
    requirementStatus: "Complete",
    machinist: "Demo A.",
    active: true,
    lastSyncedAt: "2026-09-01T12:00:00.000Z",
    drawingUrl: "https://frc190.onshape.com",
    drawingPdfUrl: null,
    drawingPdfName: null,
    stepUrl: null,
    stepName: null,
    onshapeUrl: "https://frc190.onshape.com",
  },
];
