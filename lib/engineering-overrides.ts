// Shared by the admin editor, API validation, and the override planner. The
// machine and color choices match the values the Onshape sync may deliver.
export const MACHINE_NAMES = [
  "Haas CNC",
  "Shop Sabre CNC",
  "Milling Machine",
  "Lathe",
  "Markforged 3D Printer",
  "Bambu 3D Printer",
  "Bandsaw",
  "Sander",
  "Drill Press",
  "COTS",
  "FormLabs SLA",
  "FormLabs SLS",
  "Countersinking",
  "Threaded Insert",
  "Tapping",
  "Guided Drilling",
  "Bending",
  "Bridgeport",
] as const;

export const FINISH_COLORS = ["None", "Red", "Black"] as const;
export type FinishColor = (typeof FINISH_COLORS)[number];

export const ROUTING_FIELDS = ["machine_op1", "machine_op2", "machine_op3", "machine_op4"] as const;
export type RoutingField = (typeof ROUTING_FIELDS)[number];
export type Routing = [string | null, string | null, string | null, string | null];

export const REQUIREMENT_OVERRIDE_FIELDS = ["required_quantity", "finishing", ...ROUTING_FIELDS] as const;
export const PART_OVERRIDE_FIELDS = ["material", "name", "description"] as const;
export type OverrideField = (typeof REQUIREMENT_OVERRIDE_FIELDS)[number] | (typeof PART_OVERRIDE_FIELDS)[number];
export type OverrideFileKind = "drawing-pdf" | "step";

export const MAX_OVERRIDE_QUANTITY = 10_000;
export const MAX_MATERIAL_LENGTH = 200;
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_OVERRIDE_REASON_LENGTH = 1_000;
export const MAX_OVERRIDE_FILE_BYTES = 50 * 1024 * 1024;

export type FieldEdit<T> = { value: T } | { revert: true };
export interface EngineeringOverrideFields {
  quantity?: FieldEdit<number>;
  material?: FieldEdit<string | null>;
  name?: FieldEdit<string>;
  description?: FieldEdit<string | null>;
  finishing?: FieldEdit<FinishColor>;
  routing?: FieldEdit<Routing>;
  /** Bought rather than made: retires routing and finishing until switched back. */
  offTheShelf?: { value: boolean };
}

export interface EngineeringOverrideRow {
  entity: "parts" | "requirements";
  row_id: number;
  field: OverrideField;
  value: unknown;
  synced_value: unknown;
  synced_at: string | null;
  reason: string;
  updated_by_name: string;
  updated_at: string;
}

export interface EngineeringFileSummary {
  kind: OverrideFileKind;
  name: string;
  sha256: string;
  byte_size: number;
}

export interface EngineeringFileOverride extends EngineeringFileSummary {
  /** Whether a 3D preview has been generated for this replacement STEP. */
  preview: boolean;
  reason: string;
  updated_by_name: string;
  updated_at: string;
}

/** Server-authoritative values for one requirement and its part, plus a CAS token. */
export interface EngineeringOverrideState {
  token: string;
  requirement: {
    id: number;
    production_key: string | null;
    part_id: number | null;
    required_quantity: number | null;
    finishing: string | null;
    machine_op1: string | null;
    machine_op2: string | null;
    machine_op3: string | null;
    machine_op4: string | null;
    active_in_bom: boolean | null;
    obsolete: boolean | null;
    off_the_shelf: boolean;
    off_the_shelf_changed_by: string | null;
    off_the_shelf_changed_at: string | null;
  } | null;
  part: { id: number; part_number: string | null; name: string | null; description: string | null; material: string | null } | null;
  overrides: EngineeringOverrideRow[];
  files: EngineeringFileSummary[];
  file_overrides: EngineeringFileOverride[];
}

export function isMachineName(value: unknown): value is (typeof MACHINE_NAMES)[number] {
  return typeof value === "string" && (MACHINE_NAMES as readonly string[]).includes(value);
}

export function normalizeFinishColor(value: unknown): FinishColor {
  return value === "Red" || value === "Black" ? value : "None";
}

export function routingOf(requirement: Pick<NonNullable<EngineeringOverrideState["requirement"]>, RoutingField>): Routing {
  return ROUTING_FIELDS.map((field) => requirement[field] || null) as Routing;
}

/** Operations must be listed from OP1 without gaps. */
export function routingError(routing: Routing): string | null {
  for (const machine of routing) {
    if (machine !== null && !isMachineName(machine)) return `Unknown machine: ${machine}`;
  }
  const firstGap = routing.indexOf(null);
  if (firstGap >= 0 && routing.slice(firstGap).some((machine) => machine !== null)) {
    return "List operations in order starting at OP1, without gaps";
  }
  return null;
}

/** One active correction across the whole shop, for the admin report. */
export interface EngineeringCorrection {
  kind: "field" | "file" | "off_the_shelf";
  field: string;
  value: unknown;
  synced_value: unknown;
  part_id: number;
  part_number: string | null;
  part_name: string | null;
  requirement_id: number | null;
  assembly_number: string | null;
  source_document: string | null;
  active_in_bom: boolean | null;
  reason: string;
  updated_by_name: string | null;
  updated_at: string | null;
}

export const CORRECTION_FIELD_LABELS: Record<string, string> = {
  required_quantity: "Quantity", material: "Material", name: "Name", description: "Description", finishing: "Finishing",
  machine_op1: "OP1", machine_op2: "OP2", machine_op3: "OP3", machine_op4: "OP4",
  "drawing-pdf": "Drawing PDF", step: "STEP file", off_the_shelf: "Off-the-shelf",
};
