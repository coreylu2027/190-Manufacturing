import "server-only";

import { unstable_cache } from "next/cache";

import { enrichOperationsWithQuality, qualityMetadataByRequirement, type QualityProfileRow } from "../quality-control";
import { createAdminClient } from "../supabase/admin";
import { getManufacturingDataVersion, getManufacturingSnapshot, getQualityReviews } from "./index";

async function loadQualitySourceData() {
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

const loadSnapshotByVersion = unstable_cache(
  async (version: string) => {
    void version;
    const base = await getManufacturingSnapshot();
    // Fetched after the entity reads so a cold build stays within their bounded read concurrency.
    const quality = await loadQualitySourceData();
    const { metadata: qualityByRequirement } = qualityMetadataByRequirement(
      base.operations, quality.reviews, quality.retractedIds, quality.profiles);
    const operations = enrichOperationsWithQuality(base.operations, qualityByRequirement);
    const jobs = base.jobs.map((job) => {
      const metadata = qualityByRequirement.get(job.requirementId);
      return {
        ...job,
        qcNotes: metadata?.notes ?? "",
        effectiveQcResult: metadata?.effectiveQcResult ?? "pending" as const,
        lastQualityFailure: metadata?.lastQualityFailure ?? null,
      };
    });

    return {
      operations,
      jobs,
      cotsRequirements: base.cotsRequirements,
      qualityReviews: quality.reviews,
      retractedQualityReviewIds: quality.retractedIds,
    };
  },
  ["manufacturing-projected-snapshot-v8"],
  { revalidate: false },
);

type ManufacturingSnapshot = Awaited<ReturnType<typeof loadSnapshotByVersion>>;
const inFlightSnapshots = new Map<string, Promise<ManufacturingSnapshot>>();

/** Coalesce concurrent cache misses handled by the same application instance. */
async function loadSnapshotOnce(version: string) {
  const existing = inFlightSnapshots.get(version);
  if (existing) return existing;

  const request = loadSnapshotByVersion(version);
  inFlightSnapshots.set(version, request);
  try {
    return await request;
  } finally {
    if (inFlightSnapshots.get(version) === request) inFlightSnapshots.delete(version);
  }
}

/**
 * Resolve the database's cheap transaction version first, then share the
 * expensive joined projection through Next's server Data Cache.
 */
export async function getCurrentManufacturingSnapshot() {
  let version = await getManufacturingDataVersion();
  let snapshot = await loadSnapshotOnce(version);

  // If a transaction committed while a cold cache entry was being built, use
  // the newer key before responding. A later commit is covered by Realtime.
  const verifiedVersion = await getManufacturingDataVersion();
  if (verifiedVersion !== version) {
    version = verifiedVersion;
    snapshot = await loadSnapshotOnce(version);
  }

  return { version, snapshot };
}
