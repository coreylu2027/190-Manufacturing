import type { ObsoletionFields } from "./types.ts";

export function projectObsoletion(row: Record<string, unknown> | undefined): ObsoletionFields {
  return {
    hidden: row?.hidden === true,
    offTheShelf: row?.off_the_shelf === true,
    visibilityVersion: Number(row?.visibility_version ?? 0),
    obsolete: row?.obsolete === true,
    obsoletionVersion: Number(row?.obsoletion_version ?? 0),
    obsoletionChangedAt: row?.obsoletion_changed_at ? String(row.obsoletion_changed_at) : null,
    obsoletionChangedBy: row?.obsoletion_changed_by ? String(row.obsoletion_changed_by) : null,
    obsoletionOrigin: row?.obsoletion_origin === "manual" ? "manual" : row?.obsoletion_origin === "automatic" ? "automatic" : null,
    replacementRequirementId: row?.obsolete_replacement_id == null ? null : Number(row.obsolete_replacement_id),
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
