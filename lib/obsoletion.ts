import type { ObsoletionFields } from "./types.ts";

export function projectObsoletion(row: Record<string, unknown> | undefined): ObsoletionFields {
  return {
    hidden: row?.Hidden === true,
    offTheShelf: row?.["Off The Shelf"] === true,
    visibilityVersion: Number(row?.["Visibility Version"] ?? 0),
    obsolete: row?.Obsolete === true,
    obsoletionVersion: Number(row?.["Obsoletion Version"] ?? 0),
    obsoletionChangedAt: row?.["Obsoletion Changed At"] ? String(row["Obsoletion Changed At"]) : null,
    obsoletionChangedBy: row?.["Obsoletion Changed By"] ? String(row["Obsoletion Changed By"]) : null,
    obsoletionOrigin: row?.["Obsoletion Origin"] === "manual" ? "manual" : row?.["Obsoletion Origin"] === "automatic" ? "automatic" : null,
    replacementRequirementId: row?.["Replacement Requirement"] == null ? null : Number(row["Replacement Requirement"]),
  };
}

/**
 * Moving a part onto the robot records its physical state rather than new work,
 * so a requirement restored from obsolete qualifies even when it is no longer
 * active in the BOM (restoring does not reactivate its BOM row or routing).
 */
export function robotPlacementAllowed(requirement: { obsolete?: boolean; activeInBom: boolean; obsoletionVersion?: number }) {
  return !requirement.obsolete && (requirement.activeInBom || Number(requirement.obsoletionVersion ?? 0) > 0);
}

export function workAllowed(operation: { obsolete?: boolean; activeInBom: boolean; activeInRouting: boolean }) {
  return !operation.obsolete && operation.activeInBom && operation.activeInRouting;
}
