import { NextResponse } from "next/server";

import { getAdminActor, isBootstrapAdminEmail } from "@/lib/auth";
import { getOperations } from "@/lib/baserow";
import { isShopName } from "@/lib/profile-name";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminResponse, AdminUserSummary, QualityControlItem, QualityResult } from "@/lib/types";

export const dynamic = "force-dynamic";

interface ProfileRow {
  id: string;
  display_name: string;
  role: "machinist" | "admin";
  approved: boolean;
}

interface ReviewRow {
  operation_id: number;
  result: "passed" | "failed";
  notes: string;
  reviewed_by: string;
  reviewed_at: string;
}

function emptyResponse(): AdminResponse {
  return {
    source: "demo",
    users: [],
    qualityControl: [],
  };
}

export async function GET() {
  const currentUser = await getAdminActor();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });
  if (currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const admin = createAdminClient();
  if (!admin) return NextResponse.json(emptyResponse());

  try {
    const [{ data: authData, error: authError }, { data: profileData, error: profileError }, { data: reviewData, error: reviewError }, operationData] = await Promise.all([
      admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
      admin.from("profiles").select("id, display_name, role, approved"),
      admin.from("quality_control").select("operation_id, result, notes, reviewed_by, reviewed_at"),
      getOperations(),
    ]);

    if (authError) throw authError;
    if (profileError) throw profileError;
    if (reviewError) throw reviewError;

    const profiles = new Map((profileData as ProfileRow[]).map((profile) => [profile.id, profile]));
    const users: AdminUserSummary[] = authData.users.map((user) => {
      const profile = profiles.get(user.id);
      const email = user.email ?? "No email";
      const bootstrapAdmin = isBootstrapAdminEmail(user.email);
      const metadataName = user.user_metadata.full_name ?? user.user_metadata.name ?? "";
      return {
        id: user.id,
        email,
        name: isShopName(metadataName) ? metadataName : profile?.display_name || metadataName || email.split("@")[0],
        role: bootstrapAdmin ? "admin" : profile?.role ?? "machinist",
        approved: bootstrapAdmin || Boolean(profile?.approved),
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at ?? null,
      };
    }).sort((a, b) => Number(a.approved) - Number(b.approved) || a.name.localeCompare(b.name));

    const reviews = new Map((reviewData as ReviewRow[]).map((review) => [review.operation_id, review]));
    const qualityControl: QualityControlItem[] = operationData.operations
      .filter((operation) => operation.status === "Complete" || reviews.has(operation.id))
      .map((operation) => {
        const review = reviews.get(operation.id);
        const completedAfterReview = Boolean(
          operation.status === "Complete"
          && operation.completedAt
          && review
          && new Date(operation.completedAt).getTime() > new Date(review.reviewed_at).getTime(),
        );
        const result: QualityResult = !review || completedAfterReview ? "pending" : review.result;
        return {
          operation,
          result,
          notes: result === "pending" ? "" : review?.notes ?? "",
          reviewedAt: result === "pending" ? null : review?.reviewed_at ?? null,
          reviewedBy: result === "pending" ? null : users.find((user) => user.id === review?.reviewed_by)?.name ?? null,
        };
      })
      .sort((a, b) => Number(a.result !== "pending") - Number(b.result !== "pending") || a.operation.partNumber.localeCompare(b.operation.partNumber));

    return NextResponse.json({ users, qualityControl, source: operationData.source } satisfies AdminResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load administration data" }, { status: 502 });
  }
}
