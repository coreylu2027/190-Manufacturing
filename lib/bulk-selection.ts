/**
 * Applies the grid's latest selection for visible rows without discarding
 * selections that are temporarily hidden by search or filters.
 */
export function mergeVisibleSelection(
  currentIds: readonly number[],
  visibleIds: readonly number[],
  selectedVisibleIds: readonly number[],
) {
  const visible = new Set(visibleIds);
  return [...new Set([
    ...currentIds.filter((id) => !visible.has(id)),
    ...selectedVisibleIds,
  ])];
}

/**
 * Runs bulk mutations one at a time while retaining Promise.allSettled-style
 * results. Manufacturing writes share an optimistic-concurrency token, so
 * parallel requests would invalidate each other's snapshots.
 */
export async function settleSequentially<Item, Result>(
  items: readonly Item[],
  task: (item: Item, index: number) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  const results: PromiseSettledResult<Result>[] = [];

  for (const [index, item] of items.entries()) {
    try {
      results.push({ status: "fulfilled", value: await task(item, index) });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }

  return results;
}

/** Splits settled results into fulfilled values and rejection reasons, each in their original order. */
export function partitionSettled<Result>(results: readonly PromiseSettledResult<Result>[]) {
  return {
    succeeded: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    failures: results.flatMap((result): unknown[] => result.status === "rejected" ? [result.reason] : []),
  };
}
