import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppUser } from "@/lib/auth";
import { FINISH_COLORS, MACHINE_NAMES, MAX_DESCRIPTION_LENGTH, MAX_MATERIAL_LENGTH, MAX_NAME_LENGTH, MAX_OVERRIDE_QUANTITY, MAX_OVERRIDE_REASON_LENGTH } from "@/lib/engineering-overrides";
import { applyEngineeringOverrides, readEngineeringOverrideState } from "@/lib/manufacturing";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";

export const dynamic = "force-dynamic";

const edit = <T extends z.ZodType>(value: T) => z.union([
  z.object({ value }).strict(),
  z.object({ revert: z.literal(true) }).strict(),
]);
const machine = z.enum(MACHINE_NAMES).nullable();
const schema = z.object({
  expectedToken: z.string().regex(/^[0-9a-f]{32}$/),
  reason: z.string().max(MAX_OVERRIDE_REASON_LENGTH).default(""),
  fields: z.object({
    quantity: edit(z.number().int().min(1).max(MAX_OVERRIDE_QUANTITY)).optional(),
    material: edit(z.string().max(MAX_MATERIAL_LENGTH).nullable()).optional(),
    name: edit(z.string().trim().min(1).max(MAX_NAME_LENGTH)).optional(),
    description: edit(z.string().max(MAX_DESCRIPTION_LENGTH).nullable()).optional(),
    finishing: edit(z.enum(FINISH_COLORS)).optional(),
    routing: edit(z.tuple([machine, machine, machine, machine])).optional(),
    offTheShelf: z.object({ value: z.boolean() }).strict().optional(),
  }).strict(),
}).strict();

async function authorize(params: Promise<{ id: string }>) {
  const user = await getAppUser();
  if (!user) return { error: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  if (!user.approved || user.role !== "admin") return { error: NextResponse.json({ error: "Administrator access required" }, { status: 403 }) };
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return { error: NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 }) };
  return { user, id };
}

function failure(error: unknown, fallback: string) {
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback },
    { status: error instanceof ManufacturingWriteError ? error.status : 502 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize(params);
  if (auth.error) return auth.error;
  try {
    const state = await readEngineeringOverrideState(auth.id);
    if (!state.requirement) return NextResponse.json({ error: "Production requirement not found" }, { status: 404 });
    return NextResponse.json(state, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return failure(error, "Unable to load engineering data");
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize(params);
  if (auth.error) return auth.error;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide valid engineering corrections" }, { status: 400 });
  try {
    const { notificationContext, ...result } = await applyEngineeringOverrides(auth.id, parsed.data.fields,
      parsed.data.expectedToken, parsed.data.reason, auth.user);
    const { routingChanged, ...partContext } = notificationContext;
    if (result.changes.length) {
      scheduleSlackManufacturingEvent({
        ...partContext,
        type: "engineering_corrected",
        actorName: auth.user.name,
        changes: result.changes.map((change) => `${change.field}: ${change.from} → ${change.to}`),
        reason: parsed.data.reason.trim() || undefined,
        routingChanged,
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    return failure(error, "Unable to save engineering corrections");
  }
}
