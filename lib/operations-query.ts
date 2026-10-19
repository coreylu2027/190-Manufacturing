import { queryOptions } from "@tanstack/react-query";

import type { OperationsResponse } from "@/lib/types";

/**
 * The single fetcher for the shared ["operations"] query. Every observer must use it:
 * TanStack runs whichever observer's queryFn triggers a fetch, and the workspace shell
 * redirects only on these AUTH_REQUIRED / APPROVAL_REQUIRED errors.
 */
async function fetchOperations(): Promise<OperationsResponse> {
  const response = await fetch("/api/operations", { cache: "no-store" });
  if (response.status === 401) {
    throw new Error("AUTH_REQUIRED");
  }
  if (response.status === 403) {
    throw new Error("APPROVAL_REQUIRED");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Unable to load manufacturing operations");
  }
  return response.json();
}

export const operationsQuery = queryOptions({ queryKey: ["operations"], queryFn: fetchOperations });
