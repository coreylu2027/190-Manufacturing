import "server-only";

import { DEMO_OPERATIONS } from "@/lib/demo-data";
import type { ManufacturingOperation, OperationPatch, OperationStatus } from "@/lib/types";

type BaserowRow = Record<string, unknown> & { id: number };

const OPERATIONS_TABLE_ID = process.env.BASEROW_OPERATIONS_TABLE_ID ?? "1169282";
const REQUIREMENTS_TABLE_ID = process.env.BASEROW_REQUIREMENTS_TABLE_ID ?? "1119642";
const API_URL = (process.env.BASEROW_API_URL ?? "https://api.baserow.io").replace(/\/$/, "");

export function hasBaserowCredentials() {
  return Boolean(process.env.BASEROW_API_TOKEN);
}

async function baserowFetch(path: string, init?: RequestInit) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${process.env.BASEROW_API_TOKEN}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Baserow request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

async function listAllRows(tableId: string): Promise<BaserowRow[]> {
  const first = await baserowFetch(`/api/database/rows/table/${tableId}/?user_field_names=true&size=200&page=1`);
  const rows = [...first.results] as BaserowRow[];
  const pages = Math.ceil(first.count / 200);
  for (let page = 2; page <= pages; page += 1) {
    const next = await baserowFetch(`/api/database/rows/table/${tableId}/?user_field_names=true&size=200&page=${page}`);
    rows.push(...next.results);
  }
  return rows;
}

function selectValue(value: unknown, fallback = ""): string {
  return typeof value === "object" && value !== null && "value" in value
    ? String((value as { value: unknown }).value ?? fallback)
    : fallback;
}

function linkedId(value: unknown): number | null {
  return Array.isArray(value) && value[0] && typeof value[0] === "object" && "id" in value[0]
    ? Number((value[0] as { id: unknown }).id)
    : null;
}

function linkedValue(value: unknown): string {
  return Array.isArray(value) && value[0] && typeof value[0] === "object" && "value" in value[0]
    ? String((value[0] as { value: unknown }).value ?? "")
    : "";
}

function firstFileUrl(value: unknown): string | null {
  if (Array.isArray(value) && value[0] && typeof value[0] === "object" && "url" in value[0]) {
    return String((value[0] as { url: unknown }).url);
  }
  return null;
}

function parseRequirement(display: string) {
  const match = display.match(/^(.+?)\s+—\s+(.+?)\s+\[([^\]]+)]$/);
  return {
    partNumber: match?.[1] ?? display.split(" ")[0] ?? "Unknown",
    partName: match?.[2] ?? display,
    assemblyNumber: match?.[3] ?? "Unassigned",
  };
}

export async function getOperations(): Promise<{ operations: ManufacturingOperation[]; source: "baserow" | "demo" }> {
  if (!hasBaserowCredentials()) return { operations: DEMO_OPERATIONS, source: "demo" };

  const [operationRows, requirementRows] = await Promise.all([
    listAllRows(OPERATIONS_TABLE_ID),
    listAllRows(REQUIREMENTS_TABLE_ID),
  ]);
  const requirements = new Map(requirementRows.map((row) => [row.id, row]));

  const operations = operationRows.map((row): ManufacturingOperation => {
    const requirementId = linkedId(row["Production Requirement"]);
    const requirement = requirementId ? requirements.get(requirementId) : undefined;
    const parsed = parseRequirement(linkedValue(row["Production Requirement"]));
    const operationNumber = selectValue(row["Operation Number"], "OP1") as ManufacturingOperation["operationNumber"];
    return {
      id: row.id,
      operationKey: String(row.Operation ?? `${row.id}`),
      ...parsed,
      quantity: Number(requirement?.["Required Quantity"] ?? 1),
      operationNumber,
      machine: selectValue(row.Machine, "Unassigned"),
      status: selectValue(row.Status, "Planned") as OperationStatus,
      machinist: String(row.Machinist ?? ""),
      startedAt: row["Started At"] ? String(row["Started At"]) : null,
      completedAt: row["Completed At"] ? String(row["Completed At"]) : null,
      activeInRouting: Boolean(row["Active in Routing"]),
      drawingUrl: linkedValue(requirement?.Drawing) || null,
      drawingPdfUrl: firstFileUrl(requirement?.["Drawing PDF"]),
      stepUrl: firstFileUrl(requirement?.["STEP File"]),
      onshapeUrl: requirement?.["Onshape Source"] ? String(requirement["Onshape Source"]) : null,
    };
  });

  return { operations: operations.filter((operation) => operation.activeInRouting), source: "baserow" };
}

export async function patchOperation(id: number, patch: OperationPatch, machinist: string) {
  if (!hasBaserowCredentials()) {
    const operation = DEMO_OPERATIONS.find((item) => item.id === id);
    if (!operation) throw new Error("Operation not found");
    const timestamp = new Date().toISOString();
    return {
      ...operation,
      ...patch,
      machinist: patch.machinist ?? (patch.status === "In Progress" || patch.status === "Complete" ? machinist : operation.machinist),
      startedAt: patch.status === "In Progress" && !operation.startedAt ? timestamp : operation.startedAt,
      completedAt: patch.status === "Complete" ? timestamp : operation.completedAt,
    };
  }

  const body: Record<string, unknown> = {};
  if (patch.status) body.Status = patch.status;
  if (patch.machinist !== undefined) body.Machinist = patch.machinist;
  if ((patch.status === "In Progress" || patch.status === "Complete") && patch.machinist === undefined) body.Machinist = machinist;
  if (patch.status === "In Progress") body["Started At"] = new Date().toISOString();
  if (patch.status === "Complete") body["Completed At"] = new Date().toISOString();

  await baserowFetch(`/api/database/rows/table/${OPERATIONS_TABLE_ID}/${id}/?user_field_names=true`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return body;
}
