import "server-only";

import { unstable_cache } from "next/cache";

import { enrichOperationsWithQuality, qualityMetadataByRequirement } from "../quality-control";
import { loadQualitySourceData } from "../quality-control-server";
import { getManufacturingDataVersion, getManufacturingSnapshot } from "./index";

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
