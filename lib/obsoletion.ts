import type { ObsoletionFields } from "./types.ts";

export function projectObsoletion(row: Record<string, unknown> | undefined): ObsoletionFields {
  return {
    hidden: row?.Hidden === true,
    visibilityVersion: Number(row?.["Visibility Version"] ?? 0),
    obsolete: row?.Obsolete === true,
    obsoletionVersion: Number(row?.["Obsoletion Version"] ?? 0),
    obsoletionChangedAt: row?.["Obsoletion Changed At"] ? String(row["Obsoletion Changed At"]) : null,
    obsoletionChangedBy: row?.["Obsoletion Changed By"] ? String(row["Obsoletion Changed By"]) : null,
    obsoletionOrigin: row?.["Obsoletion Origin"] === "manual" ? "manual" : row?.["Obsoletion Origin"] === "automatic" ? "automatic" : null,
    replacementRequirementId: row?.["Replacement Requirement"] == null ? null : Number(row["Replacement Requirement"]),
  };
}

export function workAllowed(operation: { obsolete?: boolean; activeInBom: boolean; activeInRouting: boolean }) {
  return !operation.obsolete && operation.activeInBom && operation.activeInRouting;
}
