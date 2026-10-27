import type { ManufacturingAttachment, NormalizedRow } from "./model.ts";
import { projectCotsRequirements, projectOperations, projectFinishing } from "./projections.ts";
export interface AdapterConfig { url: string; serviceKey: string; fetch?: typeof fetch }
const SNAPSHOT_ENTITIES = ["assemblies", "parts", "requirements", "operations", "finishing"] as const;
const READ_CONCURRENCY = 2;
function supabaseApiHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key };
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}
/** Calls a PostgREST RPC with the service key: a POST with a JSON body, or a GET with query params. */
export function postgrestRpc(config: AdapterConfig, name: string, { body, params, timeoutMs = 30_000 }: { body?: unknown; params?: URLSearchParams; timeoutMs?: number } = {}) {
  const headers = supabaseApiHeaders(config.serviceKey);
  return (config.fetch ?? fetch)(`${config.url.replace(/\/$/, "")}/rest/v1/rpc/${name}${params ? `?${params}` : ""}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
  });
}
export function createSupabaseManufacturingAdapter(config: AdapterConfig) {
  async function readEntity(entity: string): Promise<NormalizedRow[]> {
    const rows: NormalizedRow[] = [];
    let expected: number | undefined;
    for (let offset=0; ; ) {
      const params = new URLSearchParams({p_entity:entity,p_offset:String(offset),p_limit:"500"});
      const response = await postgrestRpc(config, "manufacturing_read_entity", { params });
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
    const response = await postgrestRpc(config, "manufacturing_attachment_manifest", { body: {} });
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
  async function readDataVersion(): Promise<string> {
    const response = await postgrestRpc(config, "manufacturing_data_version", { body: {} });
    if (!response.ok) throw new Error(`Supabase manufacturing version read failed (${response.status})`);
    const data = await response.json() as unknown;
    if (typeof data !== "string" || !/^\d+$/.test(data)) {
      throw new Error("Invalid manufacturing data version");
    }
    return data;
  }
  async function readRows(): Promise<Record<string, NormalizedRow[]>> {
    const entries: Array<readonly [string, NormalizedRow[]]> = [];
    // Keep cold-cache reconstruction from opening one database statement per
    // entity at the same instant. A small amount of bounded parallelism is
    // faster in the normal case without causing a refresh stampede under load.
    for (let index = 0; index < SNAPSHOT_ENTITIES.length; index += READ_CONCURRENCY) {
      const batch = await Promise.all(SNAPSHOT_ENTITIES.slice(index, index + READ_CONCURRENCY).map(async entity =>
        [entity, (await readEntity(entity)).sort((a, b) => a.id - b.id)] as const));
      entries.push(...batch);
    }
    return Object.fromEntries(entries);
  }
  async function readSnapshot() {
    const [rows, attachments] = await Promise.all([readRows(), readAttachments()]);
    const operations = projectOperations(rows.operations, rows.requirements, rows.parts, attachments, rows.assemblies);
    return {
      operations,
      jobs: projectFinishing(rows.finishing, rows.requirements, attachments, rows.operations, rows.parts, rows.assemblies),
      cotsRequirements: projectCotsRequirements(rows.requirements, rows.parts, rows.assemblies, operations),
    };
  }
  return { readEntity, readAttachments, readDataVersion, readSnapshot };
}
