import "server-only";

import { getRetractedQualityReviewIds } from "./manufacturing";
import { qualityMetadataByRequirement, type QualityProfileRow, type QualityReviewRow } from "./quality-control";
import { createAdminClient } from "./supabase/admin";
import type { ManufacturingOperation } from "./types";

export async function loadQualityMetadata(operations: ManufacturingOperation[]) {
  const admin = createAdminClient();
  if (!admin) throw new Error("Supabase administration is not configured");

  const [{ data: reviews, error: reviewError }, { data: profiles, error: profileError }, retractedIds] = await Promise.all([
    admin.from("quality_control").select(
      "id, production_requirement_id, operation_id, result, notes, reviewed_by, reviewed_at, storage_location, location_updated_by, location_updated_at",
    ),
    admin.from("profiles").select("id, display_name"),
    getRetractedQualityReviewIds(),
  ]);
  if (reviewError) throw reviewError;
  if (profileError) throw profileError;

  return qualityMetadataByRequirement(
    operations,
    reviews as QualityReviewRow[],
    retractedIds,
    profiles as QualityProfileRow[],
  ).metadata;
}
