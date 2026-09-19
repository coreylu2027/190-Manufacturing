import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { deliverStoredNotificationEmail } from "@/lib/notifications";

// Supabase Database Webhook: public.notifications INSERT. Fetch the trusted
// row by ID; never use recipients or message content supplied in the request.
export async function POST(request: Request) {
  const secret = process.env.NOTIFICATION_WEBHOOK_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!secret || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (body?.type !== "INSERT" || body?.schema !== "public" || body?.table !== "notifications"
    || typeof body?.record?.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.record.id)) {
    return NextResponse.json({ error: "Invalid notification event" }, { status: 400 });
  }
  const result = await deliverStoredNotificationEmail(body.record.id);
  return NextResponse.json(result, { status: result.email === "failed" ? 502 : 200 });
}
