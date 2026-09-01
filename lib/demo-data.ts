import type { ManufacturingOperation } from "@/lib/types";

const shared = {
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
  machinist: "",
  startedAt: null,
  completedAt: null,
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
];

export const DEMO_OPERATIONS: ManufacturingOperation[] = DEMO_OPERATION_ROWS.map((operation) => {
  if (operation.status === "Complete") {
    return {
      ...operation,
      completedQuantity: operation.quantity,
      allocations: [{ userId: "demo-admin", name: "Demo M.", claimed: 0, completed: operation.quantity }],
      machinist: "Demo M.",
    };
  }
  if (operation.status === "In Progress") {
    return {
      ...operation,
      claimedQuantity: operation.quantity,
      allocations: [{ userId: "demo-admin", name: "Demo M.", claimed: operation.quantity, completed: 0 }],
      machinist: "Demo M.",
    };
  }
  return { ...operation, availableQuantity: operation.status === "Ready" ? operation.quantity : 0 };
});
