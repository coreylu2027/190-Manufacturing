import "server-only";

import { getQualityReviews } from "./manufacturing";
import type { QualityProfileRow } from "./quality-control";
import { createAdminClient } from "./supabase/admin";

export async function loadQualitySourceData() {
  const admin = createAdminClient();
  if (!admin) throw new Error("Supabase administration is not configured");

  const [{ reviews, retractedIds }, { data: profiles, error: profileError }] = await Promise.all([
    getQualityReviews(),
    admin.from("profiles").select("id, display_name"),
  ]);
  if (profileError) throw profileError;

  return {
    // Whole quality_control rows arrive; the cached snapshot keeps only what the QC projections read.
    reviews: reviews.map(({ id, production_requirement_id, operation_id, result, notes, rejected_quantity, reviewed_by, reviewed_at }) =>
      ({ id, production_requirement_id, operation_id, result, notes, rejected_quantity, reviewed_by, reviewed_at })),
    profiles: profiles as QualityProfileRow[],
    retractedIds,
  };
}
