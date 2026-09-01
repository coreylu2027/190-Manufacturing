import { NextResponse } from "next/server";
import { z } from "zod";

import { APP_ROLES, getAdminActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

const userUpdateSchema = z.object({
  approved: z.boolean(),
  role: z.enum(APP_ROLES),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const currentUser = await getAdminActor();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved || currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const parsed = userUpdateSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const { id } = await params;
  if (id === currentUser.id && (!parsed.data.approved || parsed.data.role !== "admin")) {
    return NextResponse.json({ error: "You cannot revoke or demote your own administrator account" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Supabase administration is not configured (SUPABASE_SERVICE_ROLE_KEY is missing)" },
      { status: 503 },
    );
  }

  const { data: authData, error: authError } = await admin.auth.admin.getUserById(id);
  if (authError || !authData.user) return NextResponse.json({ error: authError?.message ?? "User not found" }, { status: 404 });

  const email = authData.user.email ?? "";
  const displayName = authData.user.user_metadata.full_name ?? authData.user.user_metadata.name ?? email.split("@")[0] ?? "Machinist";
  const { error } = await admin.from("profiles").upsert({
    id,
    email,
    display_name: displayName,
    approved: parsed.data.approved,
    role: parsed.data.role,
    approved_by: parsed.data.approved ? currentUser.id : null,
    approved_at: parsed.data.approved ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });

  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  return NextResponse.json({ user: { id, ...parsed.data } });
}
