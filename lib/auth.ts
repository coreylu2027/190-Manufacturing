import "server-only";

import { isShopName } from "@/lib/profile-name";
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

export const DEMO_ADMIN: AppUser = {
  id: "demo-admin",
  name: "Demo A.",
  email: null,
  role: "admin",
  approved: true,
};

const persistedBootstrapAdmins = new Set<string>();

async function persistBootstrapAdmin(id: string, email: string | null, displayName: string) {
  if (persistedBootstrapAdmins.has(id)) return;
  const admin = createAdminClient();
  if (!admin) return;
  const timestamp = new Date().toISOString();
  const { error } = await admin.from("profiles").upsert({
    id,
    email: email ?? "",
    display_name: displayName,
    role: "admin",
    approved: true,
    approved_by: id,
    approved_at: timestamp,
    updated_at: timestamp,
  }, { onConflict: "id" });
  if (!error) persistedBootstrapAdmins.add(id);
}

export function isBootstrapAdminEmail(email: string | null | undefined) {
  if (!email) return false;
  const configured = (process.env.INITIAL_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(email.toLowerCase());
}

export function isAuthRequired() {
  // Live manufacturing data must never be exposed through a demo identity.
  return process.env.REQUIRE_AUTH === "true"
    || Boolean(process.env.BASEROW_API_TOKEN)
    || process.env.MANUFACTURING_READ_SOURCE === "supabase"
    || process.env.MANUFACTURING_WRITE_SOURCE === "supabase";
}

export async function getAppUser(): Promise<AppUser | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const email = user.email ?? null;
  const metadataName = user.user_metadata.full_name ?? user.user_metadata.name ?? "";
  const fallbackName = metadataName || email?.split("@")[0] || "Machinist";
  if (isBootstrapAdminEmail(email)) {
    await persistBootstrapAdmin(user.id, email, fallbackName);
    return { id: user.id, name: fallbackName, email, role: "admin", approved: true };
  }

  const supabase = await createClient();
  if (!supabase) return { id: user.id, name: fallbackName, email, role: "machinist", approved: false };

  const { data } = await supabase
    .from("profiles")
    .select("display_name, role, approved")
    .eq("id", user.id)
    .maybeSingle();

  return {
    id: user.id,
    name: isShopName(metadataName) ? metadataName : data?.display_name || fallbackName,
    email,
    role: data?.role === "admin" ? "admin" : "machinist",
    approved: Boolean(data?.approved),
  };
}

export async function getEffectiveAppUser() {
  return (await getAppUser()) ?? (!isAuthRequired() ? DEMO_ADMIN : null);
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
  const user = await getAppUser();
  if (user) return user;

  const liveAdminDataConfigured = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.BASEROW_API_TOKEN);
  return !isAuthRequired() && !liveAdminDataConfigured ? DEMO_ADMIN : null;
}
