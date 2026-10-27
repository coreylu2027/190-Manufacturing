import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, parseId, readJson, requireUser } from "@/lib/api-route";
import { MAX_OVERRIDE_REASON_LENGTH, type OverrideFileKind } from "@/lib/engineering-overrides";
import { setAttachmentOverride } from "@/lib/manufacturing";
import { createStagedUpload, promoteStagedUpload } from "@/lib/manufacturing/file-overrides";
import { scheduleSlackManufacturingEvent } from "@/lib/slack-notifications";

const token = z.string().regex(/^[0-9a-f]{32}$/);
const reason = z.string().max(MAX_OVERRIDE_REASON_LENGTH).default("");
const startSchema = z.object({ name: z.string().min(1).max(240), byteSize: z.number().int().positive() }).strict();
const finishSchema = z.object({ stagingPath: z.string().max(200), name: z.string().min(1).max(240), expectedToken: token, reason }).strict();
const revertSchema = z.object({ expectedToken: token, reason }).strict();

type Params = { params: Promise<{ id: string; kind: string }> };

async function authorize({ params }: Params) {
  const { user, response } = await requireUser({ admin: true });
  if (response) return { response };
  const { id: rawId, kind } = await params;
  const id = parseId(rawId);
  if (id === null) return { response: NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 }) };
  if (kind !== "drawing-pdf" && kind !== "step") return { response: NextResponse.json({ error: "Invalid file type" }, { status: 400 }) };
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

/** Authorizes a direct browser upload to a private staging path. */
export async function POST(request: Request, context: Params) {
  const auth = await authorize(context);
  if (auth.response) return auth.response;
  const parsed = await readJson(request, startSchema);
  if (!parsed.success) return NextResponse.json({ error: "Provide the file name and size" }, { status: 400 });
  try {
    return NextResponse.json(await createStagedUpload(auth.kind, parsed.data.name, parsed.data.byteSize));
  } catch (error) {
    return errorResponse(error, "Unable to replace the file");
  }
}

/** Verifies the staged upload and makes it this part's file until reverted. */
export async function PUT(request: Request, context: Params) {
  const auth = await authorize(context);
  if (auth.response) return auth.response;
  const parsed = await readJson(request, finishSchema);
  if (!parsed.success) return NextResponse.json({ error: "Provide the uploaded file" }, { status: 400 });
  try {
    const file = await promoteStagedUpload(auth.kind, parsed.data.stagingPath, parsed.data.name);
    const result = await setAttachmentOverride(auth.id, auth.kind, file, parsed.data.expectedToken, parsed.data.reason, auth.user);
    return NextResponse.json(announce(result, auth.user.name, parsed.data.reason));
  } catch (error) {
    return errorResponse(error, "Unable to replace the file");
  }
}

/** Returns to the file delivered by the Onshape sync. */
export async function DELETE(request: Request, context: Params) {
  const auth = await authorize(context);
  if (auth.response) return auth.response;
  const parsed = await readJson(request, revertSchema);
  if (!parsed.success) return NextResponse.json({ error: "Provide expectedToken" }, { status: 400 });
  try {
    const result = await setAttachmentOverride(auth.id, auth.kind, null, parsed.data.expectedToken, parsed.data.reason, auth.user);
    return NextResponse.json(announce(result, auth.user.name, parsed.data.reason));
  } catch (error) {
    return errorResponse(error, "Unable to replace the file");
  }
}
