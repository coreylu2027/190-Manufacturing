/**
 * Calls one of the app's JSON API routes. A failed response throws its `error`
 * message (or `fallbackError`) with the HTTP status attached as `status`; a
 * successful response that is not JSON rejects with the parse error.
 */
export async function requestJson<T>(url: string, init: RequestInit = {}, fallbackError = "Request failed"): Promise<T> {
  const response = await fetch(url, init.body === undefined
    ? init
    : { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  const body = response.ok ? await response.json() : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error ?? fallbackError), { status: response.status });
  return body as T;
}

/** The HTTP status requestJson attached to a failure; undefined for network errors. */
export function errorStatus(error: unknown) {
  return (error as { status?: number } | null)?.status;
}
