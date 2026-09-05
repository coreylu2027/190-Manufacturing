import { createHash } from "node:crypto";

export type Row = Record<string, unknown> & { id: number };
export type Field = Record<string, unknown> & {
  id: number; name: string; type: string; link_row_table_id?: number;
};
export interface SourceTable { id: number; fields: Field[]; rows: Row[] }
export interface Link {
  source_table_id: number; source_row_id: number; field_id: number;
  position: number; target_table_id: number; target_row_id: number;
  external: boolean;
}

// Sort object keys only. Array order, strings, nulls and numeric types are data.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function validateTables(tables: SourceTable[], excludedTableIds: number[] = []): Link[] {
  const byId = new Map(tables.map((table) => [table.id, table]));
  if (byId.size !== tables.length) throw new Error("Duplicate source table ID");
  const ids = new Map<number, Set<number>>();
  for (const table of tables) {
    const rows = new Set(table.rows.map((row) => row.id));
    if (rows.size !== table.rows.length) throw new Error(`Duplicate row IDs in table ${table.id}`);
    if ([...rows].some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error(`Invalid row ID in table ${table.id}`);
    if (new Set(table.fields.map((field) => field.id)).size !== table.fields.length) throw new Error(`Duplicate field IDs in table ${table.id}`);
    ids.set(table.id, rows);
  }
  const links: Link[] = [];
  for (const table of tables) for (const field of table.fields) {
    if (field.type !== "link_row") continue;
    const targetId = field.link_row_table_id;
    const external = targetId !== undefined && excludedTableIds.includes(targetId);
    if (!targetId || (!byId.has(targetId) && !external)) throw new Error(`Missing linked table for ${table.id}/${field.id}`);
    for (const row of table.rows) {
      const values = row[field.name];
      if (!Array.isArray(values)) throw new Error(`Invalid link array ${table.id}/${row.id}/${field.name}`);
      values.forEach((value, position) => {
        const targetRowId = value?.id;
        if (!Number.isSafeInteger(targetRowId) || targetRowId <= 0 || (!external && !ids.get(targetId)?.has(targetRowId))) {
          throw new Error(`Dangling link ${table.id}/${row.id}/${field.name} -> ${targetId}/${targetRowId}`);
        }
        links.push({ source_table_id: table.id, source_row_id: row.id, field_id: field.id,
          position, target_table_id: targetId, target_row_id: targetRowId, external });
      });
    }
  }
  return links;
}

export function validateQc(tables: SourceTable[], reviews: Record<string, unknown>[], operationsId: number, requirementsId: number) {
  const operations = new Map(tables.find((t) => t.id === operationsId)?.rows.map((r) => [r.id, r]));
  const requirements = new Set(tables.find((t) => t.id === requirementsId)?.rows.map((r) => r.id));
  return reviews.map((review) => {
    const operationId = review.operation_id === null || review.operation_id === undefined ? null : Number(review.operation_id);
    const directId = review.production_requirement_id === null || review.production_requirement_id === undefined
      ? null : Number(review.production_requirement_id);
    const operation = operationId === null ? undefined : operations.get(operationId);
    const linked = operation?.["Production Requirement"] as Array<{ id: number }> | undefined;
    const mappedId = linked?.length === 1 ? linked[0].id : null;
    // Historical operation IDs may refer to deleted operations. Preserve these as
    // provenance when a valid requirement is already present; never rewrite QC.
    const requirementId = directId ?? mappedId;
    if (requirementId === null || !requirements.has(requirementId)) throw new Error(`Unresolved QC requirement for review ${review.id ?? operationId}`);
    if (directId && mappedId && directId !== mappedId) throw new Error(`Conflicting QC references for review ${review.id}`);
    return { review_id: review.id ?? null, legacy_operation_id: operationId,
      requirement_id: requirementId, historical_operation_missing: operationId !== null && !operation };
  });
}

export function sqlLiteral(value: unknown): string {
  // Base64 cannot close either a SQL literal or the surrounding DO dollar quote.
  // Production notes and ledger text must never become executable SQL.
  return `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString("base64")}', 'base64'), 'UTF8')::jsonb`;
}

export async function readBaserowPages(
  get: (page: number) => Promise<{ count: number; results: Row[] }>,
): Promise<Row[]> {
  const rows: Row[] = [];
  let expected: number | undefined;
  for (let page = 1; ; page++) {
    const data = await get(page);
    if (!Number.isSafeInteger(data.count) || data.count < 0 || !Array.isArray(data.results)) throw new Error("Malformed Baserow page");
    expected ??= data.count;
    if (expected !== data.count) throw new Error("Baserow row count changed during pagination; retry a fresh snapshot");
    rows.push(...data.results);
    if (rows.length > expected || new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Duplicate or excess Baserow rows");
    if (rows.length === expected) return rows.sort((a, b) => a.id - b.id);
    if (!data.results.length) throw new Error("Baserow pagination ended before the advertised count");
  }
}
