import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { renameMachinistAllocations } from "@/lib/baserow";
import { formatShopName, shopNameSchema } from "@/lib/profile-name";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  return NextResponse.json({ user });
}

export async function PATCH(request: Request) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const parsed = shopNameSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json({ error: "Account profile updates are not configured" }, { status: 503 });

  const displayName = formatShopName(parsed.data.firstName, parsed.data.lastInitial);
  await renameMachinistAllocations(user.id, user.name, displayName);
  const [{ error: profileError }, { error: authError }] = await Promise.all([
    admin.from("profiles").update({ display_name: displayName, updated_at: new Date().toISOString() }).eq("id", user.id),
    admin.auth.admin.updateUserById(user.id, { user_metadata: { full_name: displayName } }),
  ]);
  if (profileError || authError) {
    return NextResponse.json({ error: profileError?.message ?? authError?.message ?? "Unable to update profile" }, { status: 502 });
  }

  return NextResponse.json({ user: { ...user, name: displayName } });
}
