import { ENTITIES, denormalizeRow, type ManufacturingAttachment, type NormalizedRow, type RawRow } from "./model.ts";
import { projectOperations, projectFinishing } from "./projections.ts";
export interface AdapterConfig { url: string; serviceKey: string; fetch?: typeof fetch }
export type ManufacturingRows = Record<string, RawRow[]>;
export function supabaseApiHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key };
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}
export function createSupabaseManufacturingAdapter(config: AdapterConfig) {
  const request = config.fetch ?? fetch;
  const baseUrl = config.url.replace(/\/$/, "");
  const headers = supabaseApiHeaders(config.serviceKey);
  async function readEntity(entity: string): Promise<NormalizedRow[]> {
    const rows: NormalizedRow[] = [];
    let expected: number | undefined;
    for (let offset=0; ; ) {
      const params = new URLSearchParams({p_entity:entity,p_offset:String(offset),p_limit:"500"});
      const response = await request(baseUrl+"/rest/v1/rpc/manufacturing_read_entity?"+params, {
        method:"GET", headers,
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
  async function readAttachments(): Promise<ManufacturingAttachment[]> {
    const response = await request(`${baseUrl}/rest/v1/rpc/manufacturing_attachment_manifest`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Supabase manufacturing attachment read failed (${response.status})`);
    const data = await response.json() as unknown;
    if (!Array.isArray(data)) throw new Error("Invalid manufacturing attachment manifest");
    return data.map((value) => {
      if (!value || typeof value !== "object") throw new Error("Invalid manufacturing attachment manifest row");
      const row = value as Record<string, unknown>;
      const partId = Number(row.part_id);
      const position = Number(row.position);
      const kind = row.kind;
      const originalName = row.original_name;
      if (!Number.isSafeInteger(partId) || partId <= 0
        || !Number.isSafeInteger(position) || position < 0
        || (kind !== "drawing-pdf" && kind !== "step")
        || typeof originalName !== "string" || !originalName.trim()) {
        throw new Error("Invalid manufacturing attachment manifest row");
      }
      return { partId, position, kind, originalName };
    });
  }
  async function readRows(): Promise<ManufacturingRows> {
    const entries = await Promise.all(ENTITIES.map(async entity => [entity.name,
      (await readEntity(entity.name)).map(row => {
        const raw = denormalizeRow(entity, row);
        return entity.name === "requirements" ? {
          ...raw,
          "Part Location": row.part_location ?? null,
          "Location Updated By": row.location_updated_by ?? null,
          "Location Updated At": row.location_updated_at ?? null,
        } : raw;
      })
        .sort((a,b)=>Number(a.order??a.id)-Number(b.order??b.id) || a.id-b.id)] as const));
    return Object.fromEntries(entries);
  }
  return {
    readEntity, readAttachments, readRows,
    async getOperations() {
      const [rows, attachments] = await Promise.all([readRows(), readAttachments()]);
      return { operations: projectOperations(rows.operations, rows.requirements, rows.parts, attachments) };
    },
    async getFabricationJobs() {
      const [rows, attachments] = await Promise.all([readRows(), readAttachments()]);
      return { jobs: projectFinishing(rows.finishing, rows.requirements, attachments, rows.operations) };
    }
  };
}
