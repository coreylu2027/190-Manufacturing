interface QualityControlRow {
  operation_id: number;
  production_requirement_id?: number | null;
  result: "passed" | "failed";
}

type BaserowRow = Record<string, unknown> & { id: number };

const apply = process.argv.includes("--apply");
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const baserowUrl = (process.env.BASEROW_API_URL ?? "https://api.baserow.io").replace(/\/$/, "");
const baserowToken = process.env.BASEROW_API_TOKEN;
const operationsTableId = process.env.BASEROW_OPERATIONS_TABLE_ID ?? "1169282";

if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase service-role configuration is required");
if (!baserowToken) throw new Error("Baserow API configuration is required");
const supabaseServiceRoleKey = serviceRoleKey;

async function listBaserowRows(): Promise<BaserowRow[]> {
  const rows: BaserowRow[] = [];
  let page = 1;
  while (true) {
    const response = await fetch(`${baserowUrl}/api/database/rows/table/${operationsTableId}/?user_field_names=true&size=200&page=${page}`, {
      headers: { Authorization: `Token ${baserowToken}` },
    });
    if (!response.ok) throw new Error(`Unable to read Baserow operations (${response.status})`);
    const body = await response.json() as { count: number; results: BaserowRow[] };
    rows.push(...body.results);
    if (rows.length >= body.count) return rows;
    page += 1;
  }
}

function linkedRequirementId(row: BaserowRow): number | null {
  const value = row["Production Requirement"];
  return Array.isArray(value) && value[0] && typeof value[0] === "object" && "id" in value[0]
    ? Number((value[0] as { id: unknown }).id)
    : null;
}

async function listQualityControlRows(includeRequirementId: boolean): Promise<QualityControlRow[]> {
  const columns = includeRequirementId
    ? "operation_id,production_requirement_id,result"
    : "operation_id,result";
  const response = await fetch(`${supabaseUrl}/rest/v1/quality_control?select=${columns}`, {
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      Range: "0-9999",
    },
  });
  if (!response.ok) throw new Error(`Unable to read Supabase QC records (${response.status})`);
  return response.json() as Promise<QualityControlRow[]>;
}

const [operations, reviews] = await Promise.all([
  listBaserowRows(),
  listQualityControlRows(apply),
]);
const requirementByOperation = new Map(operations.map((row) => [row.id, linkedRequirementId(row)]));
const mapped = reviews.map((review) => ({
  ...review,
  requirementId: requirementByOperation.get(Number(review.operation_id)) ?? null,
}));
const unmapped = mapped.filter((review) => !review.requirementId);
const duplicateRequirementIds = [...new Set(mapped
  .filter((review) => review.requirementId)
  .map((review) => review.requirementId as number)
  .filter((requirementId, index, values) => values.indexOf(requirementId) !== index))];

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  reviews: reviews.length,
  passed: reviews.filter((review) => review.result === "passed").length,
  failed: reviews.filter((review) => review.result === "failed").length,
  mapped: mapped.length - unmapped.length,
  unmappedOperationIds: unmapped.map((review) => review.operation_id),
  duplicateRequirementIds,
}, null, 2));

if (unmapped.length > 0) throw new Error("Migration stopped because one or more QC records could not be mapped");
if (!apply) process.exit(0);

for (const review of mapped) {
  const response = await fetch(`${supabaseUrl}/rest/v1/quality_control?operation_id=eq.${review.operation_id}`, {
    method: "PATCH",
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ production_requirement_id: review.requirementId }),
  });
  if (!response.ok) throw new Error(`Unable to migrate QC record for operation ${review.operation_id} (${response.status})`);
}

const verified = await listQualityControlRows(true);
const remaining = verified.filter((review) => !review.production_requirement_id);
if (remaining.length > 0) throw new Error(`Migration verification failed for ${remaining.length} QC record(s)`);
console.log(`Verified ${verified.length} requirement-level QC record(s).`);
