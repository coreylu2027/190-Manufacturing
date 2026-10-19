import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getCurrentUser } from "@/lib/supabase/server";

export const APP_ROLES = ["machinist", "admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface AppUser {
  id: string;
  name: string;
  email: string | null;
  role: AppRole;
  approved: boolean;
}

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

export async function getAppUser(): Promise<AppUser | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const email = user.email ?? null;
  const supabase = await createClient();
  const { data, error } = supabase
    ? await supabase.from("profiles").select("display_name, role, approved").eq("id", user.id).maybeSingle()
    : { data: null, error: null };
  // Without the profile the shop name is unknown; never fall back to metadata for an existing account.
  if (error) throw new Error(`Unable to load your profile: ${error.message}`);
  // The shop name decides who owns claimed work, so it comes from the profile,
  // which only the server writes. Auth metadata is editable from the browser and
  // only names an account that has no profile yet.
  const profileName = data ? String(data.display_name ?? "").trim() : user.user_metadata.full_name ?? user.user_metadata.name ?? "";
  const name = profileName || email?.split("@")[0] || "Machinist";
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

export async function getAdminActor() {
  return getAppUser();
}
