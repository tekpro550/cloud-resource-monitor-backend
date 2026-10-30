/**
 * Thin fetch wrapper for the portal API.
 * - Cookies carry the HttpOnly session; nothing sensitive is stored in localStorage.
 * - The CSRF token is held in memory only and sent on state-changing requests.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

type SessionListener = (reason: "expired" | "unauthenticated") => void;
let onSessionEnded: SessionListener | null = null;
export function onSessionEnd(listener: SessionListener | null) {
  onSessionEnded = listener;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export function buildQuery(q?: Query): string {
  if (!q) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function apiRequest<T>(method: string, path: string, body?: unknown, opts: { silentAuth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Unable to reach the server. Check your connection and try again.");
  }

  if (res.status === 204) return undefined as T;
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const err = payload?.error;
    const apiErr = new ApiError(
      res.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
      err?.requestId,
    );
    if (res.status === 401 && !opts.silentAuth) onSessionEnded?.(apiErr.code === "SESSION_EXPIRED" ? "expired" : "unauthenticated");
    throw apiErr;
  }
  return payload?.data as T;
}

export const http = {
  get: <T>(path: string, query?: Query, opts?: { silentAuth?: boolean }) => apiRequest<T>("GET", `${path}${buildQuery(query)}`, undefined, opts),
  post: <T>(path: string, body: unknown = {}) => apiRequest<T>("POST", path, body),
  put: <T>(path: string, body: unknown = {}) => apiRequest<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown = {}) => apiRequest<T>("PATCH", path, body),
  delete: <T>(path: string, body?: unknown) => apiRequest<T>("DELETE", path, body),
};

/** User-facing message for any error; permission errors stay deliberately non-revealing. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.code === "FORBIDDEN") return "You do not have permission to do that.";
    if (err.status === 404) return "The item could not be found, or you do not have access to it.";
    if (err.status >= 500 && err.code === "INTERNAL_ERROR") return "Something went wrong on our side. Please try again.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
