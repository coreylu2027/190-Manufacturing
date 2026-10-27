import { NextResponse } from "next/server";
import type { ZodType } from "zod";

import { getAppUser } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";

/** The signed-in user, or the 401/403 response to send instead. Admin routes also require approval. */
export async function requireUser({ admin = false } = {}) {
  const user = await getAppUser();
  if (!user) return { response: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  if (admin && (!user.approved || user.role !== "admin")) {
    return { response: NextResponse.json({ error: "Administrator access required" }, { status: 403 }) };
  }
  if (!user.approved) {
    return { response: NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 }) };
  }
  return { user };
}

/** A database ID from the URL, or null for anything but a positive safe integer. */
export function parseId(raw: string) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Validates the JSON body; a missing or malformed body fails validation like any other bad input. */
export async function readJson<T>(request: Request, schema: ZodType<T>) {
  return schema.safeParse(await request.json().catch(() => null));
}

/** An HttpError keeps its status; anything else is an upstream failure. */
export function errorResponse(error: unknown, fallback: string) {
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback },
    { status: error instanceof HttpError ? error.status : 502 });
}
