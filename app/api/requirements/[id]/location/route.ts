import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, parseId, readJson, requireUser } from "@/lib/api-route";
import { updatePartLocation } from "@/lib/manufacturing";
import { scheduleLocationChangedEvent } from "@/lib/slack-notifications";
import { storageLocationSchema } from "@/lib/storage-locations";

const locationSchema = z.object({
  location: storageLocationSchema.nullable(),
}).strict();

export async function PATCH(request: Request, { params }: RouteContext<"/api/requirements/[id]/location">) {
  const { user, response } = await requireUser();
  if (response) return response;

  const parsed = await readJson(request, locationSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const requirementId = parseId((await params).id);
  if (requirementId === null) return NextResponse.json({ error: "Invalid production requirement ID" }, { status: 400 });

  try {
    const result = await updatePartLocation(requirementId, parsed.data.location, user);
    const { notificationContext, ...updated } = result;
    scheduleLocationChangedEvent(user.name, parsed.data.location, notificationContext);
    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error, "Unable to update the part location");
  }
}
