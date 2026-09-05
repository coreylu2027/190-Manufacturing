import { NextResponse } from "next/server";

import { getAdminActor, isBootstrapAdminEmail } from "@/lib/auth";
import { getOperations, getRetractedQualityReviewIds } from "@/lib/manufacturing";
import { isShopName } from "@/lib/profile-name";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminResponse, AdminUserSummary, QualityControlItem, QualityResult } from "@/lib/types";

export const dynamic = "force-dynamic";

interface ProfileRow {
  id: string;
  display_name: string;
  role: "machinist" | "admin";
  approved: boolean;
  last_seen_at: string | null;
}

interface ReviewRow {
  id: number;
  production_requirement_id: number | null;
  operation_id: number | null;
  result: "passed" | "failed";
  notes: string;
  reviewed_by: string;
  reviewed_at: string;
}

export async function GET() {
  const currentUser = await getAdminActor();
  if (!currentUser) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!currentUser.approved) return NextResponse.json({ error: "Account approval required" }, { status: 403 });
  if (currentUser.role !== "admin") return NextResponse.json({ error: "Administrator access required" }, { status: 403 });

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: "Supabase administration is not configured (SUPABASE_SECRET_KEY is missing)" },
      { status: 503 },
    );
  }

  try {
    const [{ data: authData, error: authError }, { data: profileData, error: profileError }, { data: reviewData, error: reviewError }, operationData, retractedIds] = await Promise.all([
      admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
      admin.from("profiles").select("id, display_name, role, approved, last_seen_at"),
      admin.from("quality_control").select("id, production_requirement_id, operation_id, result, notes, reviewed_by, reviewed_at"),
      getOperations(),
      getRetractedQualityReviewIds(),
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
        lastSeenAt: profile?.last_seen_at ?? null,
      };
    }).sort((a, b) => Number(a.approved) - Number(b.approved) || a.name.localeCompare(b.name));

    const manufacturingOperations = operationData.operations.filter((operation) =>
      operation.workType === "Manufacturing" && operation.requirementId !== null,
    );
    const requirementIdByOperation = new Map(manufacturingOperations.map((operation) => [operation.id, operation.requirementId as number]));
    const operationsByRequirement = new Map<number, typeof manufacturingOperations>();
    for (const operation of manufacturingOperations) {
      const requirementId = operation.requirementId as number;
      operationsByRequirement.set(requirementId, [...(operationsByRequirement.get(requirementId) ?? []), operation]);
    }

    const reviewsByRequirement = new Map<number, ReviewRow>();
    for (const review of reviewData as ReviewRow[]) {
      const requirementId = review.production_requirement_id ?? (review.operation_id ? requirementIdByOperation.get(review.operation_id) : undefined);
      if (!requirementId) continue;
      const current = reviewsByRequirement.get(requirementId);
      if (!current || new Date(review.reviewed_at).getTime() > new Date(current.reviewed_at).getTime()
        || review.reviewed_at === current.reviewed_at && review.id > current.id) {
        reviewsByRequirement.set(requirementId, review);
      }
    }

    const qualityControl: QualityControlItem[] = [...operationsByRequirement.entries()]
      .filter(([requirementId, operations]) => operations.every((operation) => operation.status === "Complete") || reviewsByRequirement.has(requirementId))
      .map(([requirementId, operations]) => {
        const review = reviewsByRequirement.get(requirementId);
        const latestCompletedAt = operations.reduce<string | null>((latest, operation) => {
          if (!operation.completedAt) return latest;
          return !latest || new Date(operation.completedAt).getTime() > new Date(latest).getTime() ? operation.completedAt : latest;
        }, null);
        const completedAfterReview = Boolean(
          operations.every((operation) => operation.status === "Complete")
          && latestCompletedAt
          && review
          && new Date(latestCompletedAt).getTime() > new Date(review.reviewed_at).getTime(),
        );
        const result: QualityResult = !review || completedAfterReview || retractedIds.includes(review.id) ? "pending" : review.result;
        return {
          requirementId,
          operations: [...operations].sort((a, b) => a.operationNumber.localeCompare(b.operationNumber) || a.id - b.id),
          result,
          notes: result === "pending" ? "" : review?.notes ?? "",
          reviewedAt: result === "pending" ? null : review?.reviewed_at ?? null,
          reviewedBy: result === "pending" ? null : users.find((user) => user.id === review?.reviewed_by)?.name ?? null,
        };
      })
      .sort((a, b) => Number(a.result !== "pending") - Number(b.result !== "pending") || a.operations[0].partNumber.localeCompare(b.operations[0].partNumber));

    return NextResponse.json({ users, qualityControl } satisfies AdminResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load administration data" }, { status: 502 });
  }
}
