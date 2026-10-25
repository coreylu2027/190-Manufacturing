import { NextResponse } from "next/server";

import { requireUser } from "@/lib/api-route";
import { accountName, isBootstrapAdminEmail } from "@/lib/auth";
import { getCurrentManufacturingSnapshot } from "@/lib/manufacturing/cache";
import { projectQualityControl, type QualityReviewRow } from "@/lib/quality-control";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminResponse, AdminUserSummary, UserRole } from "@/lib/types";

interface ProfileRow {
  id: string;
  display_name: string;
  role: UserRole;
  approved: boolean;
  last_seen_at: string | null;
}

export async function GET() {
  const { user: currentUser, response } = await requireUser();
  if (response) return response;
  if (currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Supabase administration is not configured (SUPABASE_SECRET_KEY is missing)" },
      { status: 503 },
    );
  }

  try {
    const [{ data: authData, error: authError }, { data: profileData, error: profileError }, manufacturingData] = await Promise.all([
      admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
      admin.from("profiles").select("id, display_name, role, approved, last_seen_at"),
      getCurrentManufacturingSnapshot(),
    ]);

    if (authError) throw authError;
    if (profileError) throw profileError;

    const profiles = new Map((profileData as ProfileRow[]).map((profile) => [profile.id, profile]));
    const users: AdminUserSummary[] = authData.users.map((user) => {
      const profile = profiles.get(user.id);
      const bootstrapAdmin = isBootstrapAdminEmail(user.email);
      return {
        id: user.id,
        email: user.email ?? "No email",
        name: accountName(user, profile, "No email"),
        role: bootstrapAdmin ? "admin" : profile?.role ?? "machinist",
        approved: bootstrapAdmin || Boolean(profile?.approved),
        createdAt: user.created_at,
        lastSeenAt: profile?.last_seen_at ?? null,
      };
    }).sort((a, b) => Number(a.approved) - Number(b.approved) || a.name.localeCompare(b.name));

    const qualityControl = projectQualityControl(
      manufacturingData.snapshot.operations.filter((operation) => !operation.hidden && !operation.offTheShelf),
      manufacturingData.snapshot.qualityReviews as QualityReviewRow[],
      manufacturingData.snapshot.retractedQualityReviewIds,
      users.map((user) => ({ id: user.id, display_name: user.name })),
    );

    return NextResponse.json({ users, qualityControl } satisfies AdminResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load administration data" }, { status: 502 });
  }
}
