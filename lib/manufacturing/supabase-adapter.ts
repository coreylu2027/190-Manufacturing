import { ENTITIES, denormalizeRow, type NormalizedRow, type RawRow } from "./model.ts";
import { projectOperations, projectFinishing } from "./projections.ts";
export interface AdapterConfig { url: string; serviceKey: string; fetch?: typeof fetch }
export type ManufacturingRows = Record<string, RawRow[]>;
export function createSupabaseManufacturingAdapter(config: AdapterConfig) {
  const request = config.fetch ?? fetch;
  async function readEntity(entity: string): Promise<NormalizedRow[]> {
    const rows: NormalizedRow[] = [];
    let expected: number | undefined;
    for (let offset=0; ; ) {
      const params = new URLSearchParams({p_entity:entity,p_offset:String(offset),p_limit:"500"});
      const response = await request(config.url.replace(/\/$/,"")+"/rest/v1/rpc/manufacturing_read_entity?"+params, {
        method:"GET", headers:{apikey:config.serviceKey,Authorization:"Bearer "+config.serviceKey},
        cache:"no-store", redirect:"error", signal:AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error("Supabase manufacturing read failed ("+response.status+")");
      const page = await response.json() as {rows:NormalizedRow[];total:number};
      if (!Array.isArray(page.rows) || !Number.isSafeInteger(page.total) || page.total<0) throw new Error("Invalid manufacturing page");
      expected ??= page.total;
      if (expected!==page.total) throw new Error("Manufacturing changed during pagination");
      rows.push(...page.rows);
      if (rows.length>expected || new Set(rows.map(r=>r.id)).size!==rows.length) throw new Error("Duplicate manufacturing page");
      if (rows.length===expected) break;
      if (!page.rows.length) throw new Error("Truncated manufacturing page");
      offset+=page.rows.length;
    }
    return rows;
  }
  async function readRows(): Promise<ManufacturingRows> {
    const entries = await Promise.all(ENTITIES.map(async entity => [entity.name,
      (await readEntity(entity.name)).map(row=>denormalizeRow(entity,row))
        .sort((a,b)=>Number(a.order??a.id)-Number(b.order??b.id) || a.id-b.id)] as const));
    return Object.fromEntries(entries);
  }
  return {
    readEntity, readRows,
    async getOperations() { const r=await readRows(); return {operations:projectOperations(r.operations,r.requirements,r.parts),source:"supabase" as const}; },
    async getFabricationJobs() { const r=await readRows(); return {jobs:projectFinishing(r.finishing,r.requirements),source:"supabase" as const}; }
  };
}
