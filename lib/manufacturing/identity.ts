import type { NormalizedRow } from "./model.ts";

export function requirementIdentity(requirement: NormalizedRow | undefined, part: NormalizedRow | undefined, assembly: NormalizedRow | undefined) {
  return {
    partNumber: String(part?.part_number ?? "").trim() || `Part #${requirement?.part_id ? Number(requirement.part_id) : "unknown"}`,
    partName: String(part?.name ?? "").trim() || "Unnamed part",
    assemblyNumber: String(assembly?.assembly_number ?? "").trim() || "Unassigned",
  };
}

export function notificationPartContext(rows: Record<string, NormalizedRow[]>, requirementId: number | null) {
  const requirement = rows.requirements?.find(row => row.id === requirementId);
  const part = rows.parts?.find(row => row.id === requirement?.part_id);
  const assembly = rows.assemblies?.find(row => row.id === requirement?.assembly_id);
  return requirementIdentity(requirement, part, assembly);
}
