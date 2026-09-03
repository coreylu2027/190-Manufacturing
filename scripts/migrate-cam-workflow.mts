import fs from "node:fs";
import path from "node:path";

import {
  CAM_REQUIRED_MACHINES,
  planRequirementWorkflow,
  type OperationWorkType,
  type WorkflowOperationStatus,
} from "../lib/manufacturing-workflow.ts";

type Row = Record<string, unknown> & { id: number };
type Field = { id: number; name: string; type: string; select_options?: Array<{ value: string }> };

const apply = process.argv.includes("--apply");
const resetAll = process.argv.includes("--reset-all");
const envFile = path.resolve(process.cwd(), ".env.local");
const env = new Map<string, string>();
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) env.set(match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
}

const apiUrl = (env.get("BASEROW_API_URL") || process.env.BASEROW_API_URL || "https://api.baserow.io").replace(/\/$/, "");
const token = env.get("BASEROW_API_TOKEN") || process.env.BASEROW_API_TOKEN;
const operationsTableId = env.get("BASEROW_OPERATIONS_TABLE_ID") || process.env.BASEROW_OPERATIONS_TABLE_ID || "1169282";
const requirementsTableId = env.get("BASEROW_REQUIREMENTS_TABLE_ID") || process.env.BASEROW_REQUIREMENTS_TABLE_ID || "1119642";

if (!token) throw new Error("BASEROW_API_TOKEN is required");

async function baserow<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Baserow ${init?.method ?? "GET"} ${pathname} failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

async function listRows(tableId: string): Promise<Row[]> {
  const first = await baserow<{ count: number; results: Row[] }>(`/api/database/rows/table/${tableId}/?user_field_names=true&size=200&page=1`);
  const rows = [...first.results];
  for (let page = 2; page <= Math.ceil(first.count / 200); page += 1) {
    const next = await baserow<{ results: Row[] }>(`/api/database/rows/table/${tableId}/?user_field_names=true&size=200&page=${page}`);
    rows.push(...next.results);
  }
  return rows;
}

async function patchRow(tableId: string, id: number, body: Record<string, unknown>) {
  return baserow<Row>(`/api/database/rows/table/${tableId}/${id}/?user_field_names=true`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function createRow(tableId: string, body: Record<string, unknown>) {
  return baserow<Row>(`/api/database/rows/table/${tableId}/?user_field_names=true`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function inParallel<T>(items: readonly T[], worker: (item: T) => Promise<unknown>, concurrency = 8) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function selectValue(value: unknown, fallback = "") {
  return value && typeof value === "object" && "value" in value
    ? String((value as { value?: unknown }).value ?? fallback)
    : typeof value === "string" ? value : fallback;
}

function linkedId(value: unknown) {
  return Array.isArray(value) && value[0] && typeof value[0] === "object" && "id" in value[0]
    ? Number((value[0] as { id: unknown }).id)
    : null;
}

function workType(row: Row): OperationWorkType {
  return selectValue(row["Work Type"], "Manufacturing") === "CAM" ? "CAM" : "Manufacturing";
}

function operationNumber(row: Row) {
  return selectValue(row["Operation Number"], "OP1");
}

function machine(row: Row) {
  return selectValue(row.Machine, "Unassigned");
}

const fieldDefinitions = [
  {
    name: "Work Type",
    type: "single_select",
    select_options: [
      { value: "Manufacturing", color: "blue" },
      { value: "CAM", color: "purple" },
    ],
  },
  { name: "CAM Program Path", type: "long_text" },
  { name: "CAM Notes", type: "long_text" },
] as const;

async function ensureFields() {
  const fields = await baserow<Field[]>(`/api/database/fields/table/${operationsTableId}/`);
  const missing = fieldDefinitions.filter((definition) => !fields.some((field) => field.name === definition.name));
  if (!apply) return missing.map((field) => field.name);

  for (const definition of missing) {
    await baserow<Field>(`/api/database/fields/table/${operationsTableId}/`, {
      method: "POST",
      body: JSON.stringify(definition),
    });
  }
  return missing.map((field) => field.name);
}

interface DesiredCamTask {
  requirement: Row;
  requirementId: number;
  operationNumber: string;
  machine: string;
  key: string;
  targetRows: Row[];
}

function desiredCamTasks(requirements: Row[], operations: Row[]) {
  const result: DesiredCamTask[] = [];
  for (const requirement of requirements) {
    if (!Boolean(requirement["Active in BOM"]) || !selectValue(requirement["Machine OP1"])) continue;
    for (let index = 1; index <= 4; index += 1) {
      const targetMachine = selectValue(requirement[`Machine OP${index}`]);
      if (!(CAM_REQUIRED_MACHINES as readonly string[]).includes(targetMachine)) continue;
      const targetNumber = `OP${index}`;
      const targetRows = operations.filter((operation) =>
        linkedId(operation["Production Requirement"]) === requirement.id
        && workType(operation) === "Manufacturing"
        && Boolean(operation["Active in Routing"])
        && operationNumber(operation) === targetNumber
        && machine(operation) === targetMachine,
      );
      const productionKey = String(requirement["Production Key"] ?? `REQ-${requirement.id}`);
      result.push({
        requirement,
        requirementId: requirement.id,
        operationNumber: targetNumber,
        machine: targetMachine,
        key: `${productionKey}|CAM|${targetNumber}`,
        targetRows,
      });
    }
  }
  return result;
}

function camBody(task: DesiredCamTask) {
  return {
    Operation: task.key,
    "Production Requirement": [task.requirementId],
    "Operation Number": task.operationNumber,
    Machine: task.machine,
    "Work Type": "CAM",
    Status: "Ready",
    Machinist: "",
    "Claimed Quantity": 0,
    "Completed Quantity": 0,
    "Quantity Ledger": "",
    "Started At": null,
    "Completed At": null,
    "Active in Routing": true,
    "CAM Program Path": "",
    "CAM Notes": "",
  };
}

async function main() {
  if (apply && !resetAll) throw new Error("Apply requires --reset-all so the destructive operation reset is explicit");
  const [missingFields, initialOperations, requirements] = await Promise.all([
    ensureFields(),
    listRows(operationsTableId),
    listRows(requirementsTableId),
  ]);
  const desired = desiredCamTasks(requirements, initialOperations);
  const desiredKeys = new Set(desired.map((task) => `${task.requirementId}|${task.operationNumber}`));
  const existingCam = initialOperations.filter((operation) => workType(operation) === "CAM");
  const existingCamByTarget = new Map(existingCam.map((operation) => [
    `${linkedId(operation["Production Requirement"])}|${operationNumber(operation)}`,
    operation,
  ]));
  const duplicateCamTargets = existingCam.length - existingCamByTarget.size;
  if (duplicateCamTargets > 0) throw new Error(`Found ${duplicateCamTargets} duplicate CAM task(s); resolve them before running this migration`);

  const manufacturingRows = initialOperations.filter((operation) => workType(operation) === "Manufacturing");
  const toCreate = desired.filter((task) => !existingCamByTarget.has(`${task.requirementId}|${task.operationNumber}`));
  const toDeactivate = existingCam.filter((operation) =>
    Boolean(operation["Active in Routing"])
    && !desiredKeys.has(`${linkedId(operation["Production Requirement"])}|${operationNumber(operation)}`),
  );
  const toReset = desired.flatMap((task) => {
    const existing = existingCamByTarget.get(`${task.requirementId}|${task.operationNumber}`);
    if (!existing || machine(existing) === task.machine) return [];
    return [{ existing, task }];
  });
  const missingTargets = desired.filter((task) => task.targetRows.length === 0);
  if (missingTargets.length > 0) throw new Error(`Found ${missingTargets.length} CAM route(s) without a matching active manufacturing operation`);

  console.log(`${apply ? "APPLY" : "DRY RUN"}: CAM prerequisite migration`);
  console.log(`Schema fields to add: ${missingFields.length}${missingFields.length ? ` (${missingFields.join(", ")})` : ""}`);
  console.log(`Existing manufacturing operations to reset: ${manufacturingRows.length}`);
  console.log(`Existing CAM operations to reset: ${existingCam.length}`);
  console.log(`CAM route entries: ${desired.length} across ${new Set(desired.map((task) => task.requirementId)).size} requirements`);
  console.log(`CAM tasks to create: ${toCreate.length}`);
  console.log(`Existing CAM tasks to reset for a machine change: ${toReset.length}`);
  console.log(`Obsolete CAM tasks to deactivate: ${toDeactivate.length}`);

  if (!apply) {
    console.log("No Baserow rows were changed. Re-run with --apply --reset-all after reviewing this summary.");
    return;
  }

  await inParallel(manufacturingRows, (operation) => patchRow(operationsTableId, operation.id, {
    "Work Type": "Manufacturing",
    Status: "Planned",
    Machinist: "",
    "Claimed Quantity": 0,
    "Completed Quantity": 0,
    "Quantity Ledger": "",
    "Started At": null,
    "Completed At": null,
    "CAM Program Path": "",
    "CAM Notes": "",
  }));
  await inParallel(existingCam, (operation) => patchRow(operationsTableId, operation.id, {
    Status: "Planned",
    Machinist: "",
    "Claimed Quantity": 0,
    "Completed Quantity": 0,
    "Quantity Ledger": "",
    "Started At": null,
    "Completed At": null,
    "CAM Program Path": "",
    "CAM Notes": "",
  }));
  await inParallel(toDeactivate, (operation) => patchRow(operationsTableId, operation.id, { "Active in Routing": false }));
  await inParallel(toReset, ({ existing, task }) => patchRow(operationsTableId, existing.id, {
    Machine: task.machine,
    Status: "Ready",
    Machinist: "",
    "Claimed Quantity": 0,
    "Completed Quantity": 0,
    "Quantity Ledger": "",
    "Started At": null,
    "Completed At": null,
    "Active in Routing": true,
    "CAM Program Path": "",
    "CAM Notes": "",
  }));
  await inParallel(toCreate, (task) => createRow(operationsTableId, camBody(task)));

  const operations = await listRows(operationsTableId);
  const statusPatches: Array<{ id: number; status: WorkflowOperationStatus }> = [];
  const requirementPatches: Array<{ id: number; status: string }> = [];
  for (const requirement of requirements) {
    if (!Boolean(requirement["Active in BOM"])) continue;
    const related = operations.filter((operation) => linkedId(operation["Production Requirement"]) === requirement.id);
    const plan = planRequirementWorkflow(related.map((operation) => ({
      id: operation.id,
      operationNumber: operationNumber(operation),
      machine: machine(operation),
      workType: workType(operation),
      status: selectValue(operation.Status, "Planned") as WorkflowOperationStatus,
      active: Boolean(operation["Active in Routing"]),
    })), "Needs Triage");
    statusPatches.push(...plan.operationPatches);
    requirementPatches.push({ id: requirement.id, status: plan.requirementStatus });
  }

  await inParallel(statusPatches, (patch) => patchRow(operationsTableId, patch.id, { Status: patch.status }));
  await inParallel(requirementPatches, (patch) => patchRow(requirementsTableId, patch.id, {
    Status: patch.status,
    Machinist: "",
    "QC Outcome": "Not Inspected",
  }));

  console.log(`Operation readiness updates applied: ${statusPatches.length}`);
  console.log(`Requirement status updates applied: ${requirementPatches.length}`);
  console.log("CAM migration complete.");
}

await main();
