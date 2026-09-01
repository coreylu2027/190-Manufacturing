import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!user.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });

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
