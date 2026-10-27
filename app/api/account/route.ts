import { NextResponse } from "next/server";

import { errorResponse, readJson } from "@/lib/api-route";
import { findShopNameOwner, getAppUser } from "@/lib/auth";
import { renameMachinistAllocations } from "@/lib/manufacturing";
import { formatShopName, shopNameSchema } from "@/lib/profile-name";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function PATCH(request: Request) {
  // Any signed-in account may rename; approval is checked below.
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const parsed = await readJson(request, shopNameSchema);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });

  const displayName = formatShopName(parsed.data.firstName, parsed.data.lastInitial);
  const supabase = await createClient();
  const admin = createAdminClient();
  if (!supabase || !admin) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  try {
    // The shop name decides who owns claimed work, so two accounts cannot share one.
    if (await findShopNameOwner(admin, displayName, user.id)) {
      return NextResponse.json(
        { error: `Another account already uses the shop name "${displayName}". Add more of your first name to tell them apart.` },
        { status: 409 },
      );
    }

    if (user.approved) {
      await renameMachinistAllocations(user.id, user.name, displayName);
    } else if (!(await findShopNameOwner(admin, user.name, user.id))) {
      // An unapproved account may only rename away from a name another account holds, which blocks
      // its approval. That account keeps the name, so no work recorded under it loses its owner.
      return NextResponse.json({ error: "Account approval required", code: "APPROVAL_REQUIRED" }, { status: 403 });
    }

    const { error: profileError } = await admin
      .from("profiles")
      .update({ display_name: displayName, updated_at: new Date().toISOString() })
      .eq("id", user.id);
    if (profileError) return NextResponse.json({ error: profileError.message }, { status: 502 });

    // The profile is the record of the name; the Auth copy is informational, so a failure here is not fatal.
    const { error: authError } = await supabase.auth.updateUser({ data: { full_name: displayName } });
    if (authError) console.error("Unable to mirror the shop name into Auth metadata", authError.message);
  } catch (error) {
    return errorResponse(error, "Unable to update profile");
  }

  return NextResponse.json({ user: { ...user, name: displayName } });
}
