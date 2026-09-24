import type { ProductionStatus } from "./production-status.ts";

/** Furthest along first, so a progress bar fills from the left. */
export const PROGRESS_STATUSES = [
  "Complete", "Finishing Pending", "QC Pending", "In Progress", "Ready", "Blocked", "Planned", "Off the Shelf",
] as const satisfies readonly ProductionStatus[];

export interface ProgressRequirement {
  assemblyNumber: string;
  documentName: string | null;
  syncedFromDocument: string | null;
  status: ProductionStatus;
  obsolete: boolean;
}

/**
 * The document a requirement was synced from. Parts of an imported subassembly
 * report the subassembly's document, so the root assembly's document wins.
 * An empty string means the requirement hasn't been synced.
 */
export function syncedFrom(requirement: Pick<ProgressRequirement, "documentName" | "syncedFromDocument">) {
  return requirement.syncedFromDocument ?? requirement.documentName ?? "";
}

export interface DocumentProgress {
  /** From `syncedFrom`; empty when not synced. */
  document: string;
  assemblies: string[];
  /** Active requirements; obsolete ones are counted separately. */
  total: number;
  counts: Record<ProductionStatus, number>;
  /** Complete parts out of those the shop makes (off-the-shelf parts are bought). */
  made: { complete: number; total: number };
  percentComplete: number;
  obsolete: number;
}

/** Progress per synced-from document, sorted by document name. */
export function documentProgress(requirements: readonly ProgressRequirement[]): DocumentProgress[] {
  const groups = new Map<string, DocumentProgress>();
  for (const requirement of requirements) {
    const document = syncedFrom(requirement);
    let group = groups.get(document);
    if (!group) {
      group = { document, assemblies: [], total: 0, obsolete: 0, made: { complete: 0, total: 0 }, percentComplete: 0,
        counts: Object.fromEntries(PROGRESS_STATUSES.map((status) => [status, 0])) as Record<ProductionStatus, number> };
      groups.set(document, group);
    }
    if (requirement.obsolete) { group.obsolete += 1; continue; }
    if (!group.assemblies.includes(requirement.assemblyNumber)) group.assemblies.push(requirement.assemblyNumber);
    group.total += 1;
    group.counts[requirement.status] += 1;
    if (requirement.status !== "Off the Shelf") {
      group.made.total += 1;
      if (requirement.status === "Complete") group.made.complete += 1;
    }
  }
  return [...groups.values()]
    .filter((group) => group.total > 0)
    .map((group) => ({
      ...group,
      assemblies: group.assemblies.sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
      percentComplete: group.made.total === 0 ? 100 : Math.floor((group.made.complete / group.made.total) * 100),
    }))
    // Unsynced requirements sort last.
    .sort((left, right) => Number(!left.document) - Number(!right.document)
      || left.document.localeCompare(right.document, undefined, { numeric: true }));
}
