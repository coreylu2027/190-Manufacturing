import { queryOptions } from "@tanstack/react-query";

import { errorStatus, requestJson } from "@/lib/request-json";
import type { OperationsResponse } from "@/lib/types";

/**
 * The single fetcher for the shared ["operations"] query. Every observer must use it:
 * TanStack runs whichever observer's queryFn triggers a fetch, and the workspace shell
 * redirects only on these AUTH_REQUIRED / APPROVAL_REQUIRED errors.
 */
async function fetchOperations(): Promise<OperationsResponse> {
  try {
    return await requestJson<OperationsResponse>("/api/operations", { cache: "no-store" }, "Unable to load manufacturing operations");
  } catch (error) {
    if (errorStatus(error) === 401) throw new Error("AUTH_REQUIRED");
    if (errorStatus(error) === 403) throw new Error("APPROVAL_REQUIRED");
    throw error;
  }
}

export const operationsQuery = queryOptions({ queryKey: ["operations"], queryFn: fetchOperations });
