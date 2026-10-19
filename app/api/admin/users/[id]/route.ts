import { NextResponse } from "next/server";
import { z } from "zod";

import { APP_ROLES, findShopNameOwner, getAdminActor } from "@/lib/auth";
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
      { error: "Supabase administration is not configured (SUPABASE_SECRET_KEY is missing)" },
      { status: 503 },
    );
  }

  const { data: authData, error: authError } = await admin.auth.admin.getUserById(id);
  if (authError || !authData.user) return NextResponse.json({ error: authError?.message ?? "User not found" }, { status: 404 });

  const { data: profile, error: profileError } = await admin.from("profiles").select("display_name, approved").eq("id", id).maybeSingle();
  if (profileError) return NextResponse.json({ error: profileError.message }, { status: 502 });

  const email = authData.user.email ?? "";
  // Auth metadata is editable by the user, so it only names a profile that does not exist yet.
  const profileName = profile ? String(profile.display_name ?? "").trim() : authData.user.user_metadata.full_name ?? authData.user.user_metadata.name ?? "";
  const displayName = profileName || email.split("@")[0] || "Machinist";
  if (parsed.data.approved && !profile?.approved) {
    try {
      if (await findShopNameOwner(admin, displayName, id)) {
        return NextResponse.json(
          { error: `Another account already uses the shop name "${displayName}". Ask this person to change their shop name on the Pending page first.` },
          { status: 409 },
        );
      }
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to check shop names" }, { status: 502 });
    }
  }
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
