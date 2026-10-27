import { NextResponse } from "next/server";

import { requireUser } from "@/lib/api-route";
import { createAdminClient } from "@/lib/supabase/admin";

export async function PATCH(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await requireUser();
  if (response) return response;

  const supabase = createAdminClient();
  if (!supabase) return NextResponse.json({ error: "Notifications are not configured" }, { status: 503 });
  const { id } = await params;
  const { data, error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("recipient_id", user.id)
    .is("read_at", null)
    .select("id")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  if (!data) return NextResponse.json({ error: "Notification not found" }, { status: 404 });
  return NextResponse.json({ acknowledged: true });
}
