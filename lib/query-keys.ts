import type { QueryClient } from "@tanstack/react-query";

/** The workspace queries that read manufacturing data. */
export const MANUFACTURING_QUERY_KEYS = ["operations", "fabrication", "qc", "admin"] as const;

/** Refreshes every manufacturing workspace after a write; awaitable, but most callers fire and forget. */
export function invalidateManufacturingQueries(
  queryClient: QueryClient,
  { extraKeys = [], cancelRefetch }: { extraKeys?: readonly string[]; cancelRefetch?: boolean } = {},
) {
  return Promise.all([...MANUFACTURING_QUERY_KEYS, ...extraKeys].map((key) =>
    queryClient.invalidateQueries({ queryKey: [key] }, { cancelRefetch })));
}
