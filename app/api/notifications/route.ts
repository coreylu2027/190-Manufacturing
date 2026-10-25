import { NextResponse } from "next/server";

import { requireUser } from "@/lib/api-route";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const { user, response } = await requireUser();
  if (response) return response;

  const supabase = createAdminClient();
  if (!supabase) return NextResponse.json({ notifications: [] });
  const { data, error } = await supabase
    .from("notifications")
    .select("id, type, title, message, data, created_at")
    .eq("recipient_id", user.id)
    .is("read_at", null)
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json({
    notifications: (data ?? []).map((notification) => ({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      createdAt: notification.created_at,
    })),
  });
}
