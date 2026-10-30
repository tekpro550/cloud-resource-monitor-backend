import type { FetchLike } from "../../src/modules/storageConnectors/verifier.js";
import type { MemoryStorageAdapter } from "../../src/storage/memoryStorage.js";

/**
 * Simulates a browser/HTTP client talking to MemoryStorageAdapter pre-signed URLs:
 * signed PUT stores the body, signed GET returns it, unsigned requests get 403,
 * and CORS response headers follow each adapter's `cors` setting.
 */
export function fakeFetch(...adapters: MemoryStorageAdapter[]): FetchLike {
  return async (url, init = {}) => {
    const u = new URL(url);
    const adapter = adapters.find((a) => a.host === u.host);
    const headers = new Map<string, string>();
    const respond = (status: number, body = "") => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => body,
    });
    if (!adapter) return respond(404);
    const origin = init.headers?.Origin;
    if (origin && adapter.cors.allowOrigin && (adapter.cors.allowOrigin === "*" || adapter.cors.allowOrigin === origin)) {
      headers.set("access-control-allow-origin", adapter.cors.allowOrigin);
      if (adapter.cors.exposeEtag) headers.set("access-control-expose-headers", "ETag");
    }
    const key = decodeURI(u.pathname.slice(1));
    if (!u.searchParams.has("X-Amz-Signature")) return respond(403);
    if ((init.method ?? "GET") === "PUT") {
      headers.set("etag", `"${adapter.putObject(key, init.body ?? "", init.headers?.["Content-Type"])}"`);
      return respond(200);
    }
    const obj = adapter.objects.get(key);
    if (!obj) return respond(404);
    const cd = u.searchParams.get("response-content-disposition");
    if (cd) headers.set("content-disposition", cd);
    return respond(200, new TextDecoder().decode(obj.body));
  };
}
