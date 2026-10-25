export type RawRow = Record<string, unknown> & { id: number };
export interface ManufacturingAttachment {
  partId: number;
  kind: "drawing-pdf" | "step";
  position: number;
  originalName: string;
}
export type Kind = "text" | "number" | "boolean" | "select" | "link" | "date" | "json";
export type Column = readonly [name: string, source: string, kind: Kind, owner: "engineering" | "shop"];
export interface Entity { name: string; columns: readonly Column[] }
export const ENTITIES: readonly Entity[] = [
  { name: "assemblies", columns: [
    ["assembly_number","Assembly Number","text","engineering"],["subsystem_name","Subsystem Name","text","engineering"],
    ["active","Active","boolean","engineering"],["notes","Notes","text","shop"],["sync_schema_version","Sync Schema Version","text","engineering"]
  ]},
  { name: "parts", columns: [
    ["part_number","Part Number","text","engineering"],["name","Name","text","engineering"],["description","Description","text","engineering"],
    ["material","Material","text","engineering"],["manufacturing_method","Manufacturing Method","text","engineering"],
    ["vendor","Vendor","text","engineering"],["revision","Revision","text","engineering"],["onshape_url","OnShape Text","text","engineering"],
    ["category","Category","text","engineering"],["drawing_url","Onshape Drawing","text","engineering"],
    ["drawing_files","Drawing PDF","json","engineering"],["step_files","STEP File","json","engineering"],
    ["drawing_export_key","Drawing PDF Export Key","text","engineering"],["step_export_key","STEP Export Key","text","engineering"],
    ["active","Active","boolean","engineering"],["last_synced_at","Last Synced At","date","engineering"]
  ]},
  { name: "requirements", columns: [
    ["production_key","Production Key","text","engineering"],["part_id","Part","link","engineering"],["assembly_id","Assembly","link","engineering"],
    ["configuration","Configuration","text","engineering"],["required_quantity","Required Quantity","number","engineering"],
    ["bom_positions","BOM Positions","text","engineering"],["onshape_url","Onshape Source","text","engineering"],
    ["source_document","Source Document","text","engineering"],["source_root","Source Root","text","engineering"],
    ["source_assembly_revision","Source Assembly Revision","text","engineering"],["required_part_revision","Required Part Revision","text","engineering"],
    ["machine_op1","Machine OP1","select","engineering"],["machine_op2","Machine OP2","select","engineering"],
    ["machine_op3","Machine OP3","select","engineering"],["machine_op4","Machine OP4","select","engineering"],
    ["finishing","Finishing","select","engineering"],["active_in_bom","Active in BOM","boolean","engineering"],
    ["engineering_changed","Engineering Changed","boolean","engineering"],["last_synced_at","Last Synced At","date","engineering"],
    ["status","Status","select","shop"],["machinist","Machinist","text","shop"],["qc_outcome","QC Outcome","select","shop"],
    ["production_notes","Production Notes","text","shop"],
    ["qc_notes","QC Notes","text","shop"],["qc_reviewed_by","QC Reviewed By","text","shop"],["qc_reviewed_at","QC Reviewed At","date","shop"],
    ["disposition","Disposition","select","shop"]
  ]},
  { name: "operations", columns: [
    ["operation_key","Operation","text","engineering"],["requirement_id","Production Requirement","link","engineering"],
    ["operation_number","Operation Number","select","engineering"],["machine","Machine","select","engineering"],
    ["work_type","Work Type","select","engineering"],["active_in_routing","Active in Routing","boolean","engineering"],
    ["status","Status","select","shop"],["machinist","Machinist","text","shop"],["started_at","Started At","date","shop"],
    ["completed_at","Completed At","date","shop"],["claimed_quantity","Claimed Quantity","number","shop"],
    ["completed_quantity","Completed Quantity","number","shop"],["quantity_ledger","Quantity Ledger","text","shop"],
    ["cam_program_path","CAM Program Path","text","shop"],["cam_notes","CAM Notes","text","shop"]
  ]},
  { name: "finishing", columns: [
    ["production_key","Production Key","text","engineering"],["requirement_id","Production Requirement","link","engineering"],
    ["color","Powder Coat Color","select","engineering"],["required_quantity","Required Quantity","number","engineering"],
    ["active","Active","boolean","engineering"],["last_synced_at","Last Synced At","date","engineering"],
    ["machinist","Machinist","text","shop"]
  ]}
];
export type NormalizedRow = Record<string, unknown> & { id: number };
// Runtime values come exclusively from current columns.
export function runtimeRow(entity: Entity, record: NormalizedRow): RawRow {
  return { id: record.id, ...Object.fromEntries(entity.columns.map(([column, field, kind]) => {
    const value = record[column] ?? null;
    return [field, kind === "link" ? value === null ? [] : [{ id: value }]
      : kind === "select" ? value === null ? null : { value } : value];
  })) };
}
function fieldValue(value: unknown, kind: Kind): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (kind === "select") return typeof value === "object" && "value" in value ? (value as {value: unknown}).value : value;
  if (kind === "link") {
    if (!Array.isArray(value) || value.length > 1) throw new Error("Expected zero or one link; refusing to collapse a relationship");
    return value.length ? (typeof value[0] === "object" ? value[0].id : value[0]) : null;
  }
  if (kind === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Non-finite source quantity");
    return number;
  }
  return value;
}
export function normalizeRow(entity: Entity, row: RawRow) {
  return { id: row.id, ...Object.fromEntries(entity.columns.map(([column, source, kind]) => [column, fieldValue(row[source], kind)])) };
}
