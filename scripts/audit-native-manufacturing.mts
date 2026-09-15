// Read-only verification: never sends notifications or commits manufacturing writes.
import { manufacturingSupabaseConfig } from "../lib/manufacturing/config.ts";
import { createSupabaseManufacturingAdapter } from "../lib/manufacturing/supabase-adapter.ts";
import { notificationPartContext } from "../lib/manufacturing/identity.ts";
import { ENTITIES } from "../lib/manufacturing/model.ts";

const reader = createSupabaseManufacturingAdapter(manufacturingSupabaseConfig());
const rows = Object.fromEntries(await Promise.all(ENTITIES.map(async entity =>
  [entity.name, await reader.readEntity(entity.name)] as const)));
const missingLinks = rows.requirements.filter(row =>
  !rows.parts.some(part => part.id === row.part_id)
  || row.assembly_id !== null && !rows.assemblies.some(assembly => assembly.id === row.assembly_id));
console.log(JSON.stringify({
  counts: Object.fromEntries(Object.entries(rows).map(([entity, records]) => [entity, records.length])),
  missingLinks: missingLinks.map(row => row.id),
  requirement873: notificationPartContext(rows, 873),
  nativeAssemblyRequirements: rows.requirements.filter(row => rows.assemblies.some(assembly =>
    assembly.id === row.assembly_id && String(assembly.assembly_number).toLowerCase() === "a26c-0002"))
    .map(row => ({ id: row.id, ...notificationPartContext(rows, row.id) })),
}, null, 2));
if (missingLinks.length) process.exitCode = 1;
