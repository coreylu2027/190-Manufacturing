import { NextResponse } from "next/server";

import { getAppUser } from "@/lib/auth";
import { renameMachinistAllocations } from "@/lib/baserow";
import { formatShopName, shopNameSchema } from "@/lib/profile-name";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

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

  const displayName = formatShopName(parsed.data.firstName, parsed.data.lastInitial);
  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  try {
    await renameMachinistAllocations(user.id, user.name, displayName);

    const { error: authError } = await supabase.auth.updateUser({
      data: { full_name: displayName },
    });
    if (authError) {
      return NextResponse.json({ error: authError.message }, { status: 502 });
    }

    // Mirror the name into the profile table when elevated credentials exist,
    // but do not require them for a user to update their own Auth metadata.
    const admin = createAdminClient();
    if (admin) {
      await admin
        .from("profiles")
        .update({ display_name: displayName, updated_at: new Date().toISOString() })
        .eq("id", user.id);
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update profile" },
      { status: 502 },
    );
  }

  return NextResponse.json({ user: { ...user, name: displayName } });
}
