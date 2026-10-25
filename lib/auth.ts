import "server-only";

import type { User } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AppUser } from "@/lib/types";

const persistedBootstrapAdmins = new Set<string>();

async function persistBootstrapAdmin(id: string, email: string | null, displayName: string) {
  if (persistedBootstrapAdmins.has(id)) return;
  const admin = createAdminClient();
  if (!admin) return;
  const timestamp = new Date().toISOString();
  const grant = { role: "admin", approved: true, approved_by: id, approved_at: timestamp, updated_at: timestamp } as const;
  // An existing profile keeps its shop name; only a missing one is created with it.
  const { data, error } = await admin.from("profiles").update(grant).eq("id", id).select("id");
  if (error) return;
  if (!data.length) {
    const { error: insertError } = await admin.from("profiles").insert({ id, email: email ?? "", display_name: displayName, ...grant });
    if (insertError) return;
  }
  persistedBootstrapAdmins.add(id);
}

export function isBootstrapAdminEmail(email: string | null | undefined) {
  if (!email) return false;
  const configured = (process.env.INITIAL_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(email.toLowerCase());
}

/**
 * The shop name decides who owns claimed work, so it comes from the profile,
 * which only the server writes. Auth metadata is editable from the browser and
 * only names an account that has no profile yet.
 */
export function accountName(user: Pick<User, "email" | "user_metadata">, profile: { display_name?: unknown } | null | undefined, lastResort = "Machinist"): string {
  const profileName = profile ? String(profile.display_name ?? "").trim() : user.user_metadata.full_name ?? user.user_metadata.name ?? "";
  return profileName || user.email?.split("@")[0] || lastResort;
}

export async function getAppUser(): Promise<AppUser | null> {
  const supabase = await createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const email = user.email ?? null;
  const { data, error } = await supabase.from("profiles").select("display_name, role, approved").eq("id", user.id).maybeSingle();
  // Without the profile the shop name is unknown; never fall back to metadata for an existing account.
  if (error) throw new Error(`Unable to load your profile: ${error.message}`);
  const name = accountName(user, data);
  if (isBootstrapAdminEmail(email)) {
    await persistBootstrapAdmin(user.id, email, name);
    return { id: user.id, name, email, role: "admin", approved: true };
  }

  return {
    id: user.id,
    name,
    email,
    role: data?.role === "admin" ? "admin" : "machinist",
    approved: Boolean(data?.approved),
  };
}

/**
 * Another account, approved or not, that already uses this shop name (compared
 * case-insensitively). Revoked accounts keep their name because their shop work does.
 */
export async function findShopNameOwner(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  name: string,
  exceptUserId: string,
) {
  const { data, error } = await admin.from("profiles").select("id, display_name");
  if (error) throw new Error(error.message);
  const key = name.trim().toLocaleLowerCase();
  return data.find((profile) => profile.id !== exceptUserId
    && String(profile.display_name ?? "").trim().toLocaleLowerCase() === key)?.id ?? null;
}

export async function recordSiteVisit(userId: string) {
  const supabase = await createClient();
  if (!supabase) return;
  await supabase
    .from("profiles")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", userId);
}
