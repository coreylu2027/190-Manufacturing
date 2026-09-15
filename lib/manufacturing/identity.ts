import type { NormalizedRow, RawRow } from "./model.ts";

export function requirementIdentity(requirement: RawRow | undefined, part: RawRow | undefined, assembly: RawRow | undefined) {
  return {
    partNumber: String(part?.["Part Number"] ?? "").trim() || `Part #${linkedId(requirement?.Part) ?? "unknown"}`,
    partName: String(part?.Name ?? "").trim() || "Unnamed part",
    assemblyNumber: String(assembly?.["Assembly Number"] ?? "").trim() || "Unassigned",
  };
}

function linkedId(value: unknown): number | null {
  return Array.isArray(value) && value[0]?.id ? Number(value[0].id) : null;
}

export function notificationPartContext(rows: Record<string, NormalizedRow[]>, requirementId: number | null) {
  const requirement = rows.requirements?.find(row => row.id === requirementId);
  const part = rows.parts?.find(row => row.id === requirement?.part_id);
  const assembly = rows.assemblies?.find(row => row.id === requirement?.assembly_id);
  return {
    ...requirementIdentity(requirement ? { id: requirement.id, Part: [{ id: requirement.part_id }] } : undefined,
      part ? { id: part.id, "Part Number": part.part_number, Name: part.name } : undefined,
      assembly ? { id: assembly.id, "Assembly Number": assembly.assembly_number } : undefined),
  };
}
