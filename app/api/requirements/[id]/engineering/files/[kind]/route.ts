import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppUser } from "@/lib/auth";
import { MAX_OVERRIDE_REASON_LENGTH, type OverrideFileKind } from "@/lib/engineering-overrides";
import { setAttachmentOverride } from "@/lib/manufacturing";
import { createStagedUpload, FileOverrideError, promoteStagedUpload } from "@/lib/manufacturing/file-overrides";
import { ManufacturingWriteError } from "@/lib/manufacturing/write-adapter";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";

export const dynamic = "force-dynamic";

const token = z.string().regex(/^[0-9a-f]{32}$/);
const reason = z.string().max(MAX_OVERRIDE_REASON_LENGTH).default("");
const startSchema = z.object({ name: z.string().min(1).max(240), byteSize: z.number().int().positive() }).strict();
const finishSchema = z.object({ stagingPath: z.string().max(200), name: z.string().min(1).max(240), expectedToken: token, reason }).strict();
const revertSchema = z.object({ expectedToken: token, reason }).strict();

type Params = { params: Promise<{ id: string; kind: string }> };

async function authorize({ params }: Params) {
  const user = await getAppUser();
  if (!user) return { error: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  if (!user.approved || user.role !== "admin") return { error: NextResponse.json({ error: "Administrator access required" }, { status: 403 }) };
  const { id: rawId, kind } = await params;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return { error: NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 }) };
  if (kind !== "drawing-pdf" && kind !== "step") return { error: NextResponse.json({ error: "Invalid file type" }, { status: 400 }) };
  return { user, id, kind: kind as OverrideFileKind };
}

const FILE_LABELS: Record<OverrideFileKind, string> = { "drawing-pdf": "Drawing PDF", step: "STEP file" };

function announce(result: Awaited<ReturnType<typeof setAttachmentOverride>>, actorName: string, reason: string) {
  const { notificationContext, kind, file } = result;
  scheduleSlackManufacturingEvent({
    ...notificationContext,
    type: "engineering_corrected",
    actorName,
    changes: [file ? `${FILE_LABELS[kind]} replaced with ${file.name}` : `${FILE_LABELS[kind]} restored to the Onshape export`],
    reason: reason.trim() || undefined,
  });
  return { requirementId: result.requirementId, kind, file };
}

function failure(error: unknown) {
  const status = error instanceof ManufacturingWriteError || error instanceof FileOverrideError ? error.status : 502;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to replace the file" }, { status });
}

/** Authorizes a direct browser upload to a private staging path. */
export async function POST(request: Request, context: Params) {
  const auth = await authorize(context);
  if (auth.error) return auth.error;
  const parsed = startSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide the file name and size" }, { status: 400 });
  try {
    return NextResponse.json(await createStagedUpload(auth.kind, parsed.data.name, parsed.data.byteSize));
  } catch (error) {
    return failure(error);
  }
}

/** Verifies the staged upload and makes it this part's file until reverted. */
export async function PUT(request: Request, context: Params) {
  const auth = await authorize(context);
  if (auth.error) return auth.error;
  const parsed = finishSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide the uploaded file" }, { status: 400 });
  try {
    const file = await promoteStagedUpload(auth.kind, parsed.data.stagingPath, parsed.data.name);
    const result = await setAttachmentOverride(auth.id, auth.kind, file, parsed.data.expectedToken, parsed.data.reason, auth.user);
    return NextResponse.json(announce(result, auth.user.name, parsed.data.reason));
  } catch (error) {
    return failure(error);
  }
}

/** Returns to the file delivered by the Onshape sync. */
export async function DELETE(request: Request, context: Params) {
  const auth = await authorize(context);
  if (auth.error) return auth.error;
  const parsed = revertSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Provide expectedToken" }, { status: 400 });
  try {
    const result = await setAttachmentOverride(auth.id, auth.kind, null, parsed.data.expectedToken, parsed.data.reason, auth.user);
    return NextResponse.json(announce(result, auth.user.name, parsed.data.reason));
  } catch (error) {
    return failure(error);
  }
}
