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

/** Runs independent tasks, such as file downloads, with at most `limit` in flight. Results keep input order. */
export async function settleConcurrently<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item, index: number) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  const results = new Array<PromiseSettledResult<Result>>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

/** One target's outcome in a bulk API response, in request order. */
export type BulkOutcome<Result> = { ok: true; value: Result } | { ok: false; error: string };

export function toBulkOutcomes<Result>(results: readonly PromiseSettledResult<Result>[], fallbackError: string): BulkOutcome<Result>[] {
  return results.map((result) => result.status === "fulfilled"
    ? { ok: true, value: result.value }
    : { ok: false, error: result.reason instanceof Error ? result.reason.message : fallbackError });
}

/** Keeps each bulk request well inside the server's time limit. */
export const BULK_REQUEST_SIZE = 50;

/**
 * Posts bulk work to a bulk endpoint in chunks and returns one settled result
 * per item, in order. A request that fails rejects only its own chunk.
 */
export async function postBulk<Item, Result>(url: string, items: readonly Item[], {
  body,
  fallbackError,
  chunkSize = BULK_REQUEST_SIZE,
  onProgress,
}: {
  body: (chunk: Item[]) => unknown;
  fallbackError: string;
  chunkSize?: number;
  onProgress?: (settled: number) => void;
}): Promise<PromiseSettledResult<Result>[]> {
  const results: PromiseSettledResult<Result>[] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body(chunk)),
      });
      const payload = await response.json().catch(() => ({})) as { results?: BulkOutcome<Result>[]; error?: string };
      if (!response.ok || !Array.isArray(payload.results) || payload.results.length !== chunk.length) throw new Error(payload.error ?? fallbackError);
      results.push(...payload.results.map((outcome): PromiseSettledResult<Result> => outcome.ok
        ? { status: "fulfilled", value: outcome.value }
        : { status: "rejected", reason: new Error(outcome.error) }));
    } catch (reason) {
      results.push(...chunk.map((): PromiseSettledResult<Result> => ({ status: "rejected", reason })));
    }
    onProgress?.(results.length);
  }
  return results;
}
