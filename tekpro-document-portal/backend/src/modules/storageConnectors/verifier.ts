import { randomUUID } from "node:crypto";
import type { StorageAdapter } from "../../storage/storage.js";
import { customerPrefix } from "./policies.js";

export interface VerificationCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface VerificationResult {
  ok: boolean;
  checkedAt: string;
  checks: VerificationCheck[];
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * Exercises everything the portal needs from a customer's bucket, using real
 * HTTP requests for the browser-facing parts (pre-signed PUT with the portal
 * Origin for CORS, pre-signed GET, unsigned GET for privacy). A temporary probe
 * object under the customer's prefix is written and deleted.
 */
export async function verifyStorage(
  adapter: StorageAdapter,
  opts: { customerId: string; appOrigin: string; fetch: FetchLike },
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  const key = `${customerPrefix(opts.customerId)}_portal-connection-test/${randomUUID()}`;
  const body = `tekpro-portal-connection-test ${new Date().toISOString()}`;
  let uploaded = false;

  const run = async (id: string, label: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      checks.push({ id, label, ok: true, ...(detail ? { detail } : {}) });
      return true;
    } catch (err) {
      checks.push({ id, label, ok: false, detail: (err as Error).message.slice(0, 300) });
      return false;
    }
  };

  const reachable = await run("access", "Credentials can access the customer folder in the bucket", () => adapter.checkConnectivity());
  if (reachable) {
    await run("upload", "Browser-style upload with a pre-signed URL", async () => {
      const put = await adapter.presignPut(key, { contentType: "text/plain", contentLength: Buffer.byteLength(body), expiresInSeconds: 120 });
      const res = await opts.fetch(put.url, { method: "PUT", headers: { ...put.headers, Origin: opts.appOrigin }, body });
      if (!res.ok) throw new Error(`Storage returned HTTP ${res.status}`);
      uploaded = true;
      const allowOrigin = res.headers.get("access-control-allow-origin");
      const expose = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
      checks.push({
        id: "cors",
        label: `Bucket CORS allows uploads from ${opts.appOrigin}`,
        ok: allowOrigin === opts.appOrigin || allowOrigin === "*",
        ...(allowOrigin === opts.appOrigin || allowOrigin === "*" ? {} : { detail: "Add the CORS rule shown in the setup instructions" }),
      });
      checks.push({
        id: "cors-etag",
        label: "Bucket CORS exposes the ETag header (needed for large uploads)",
        ok: expose.includes("etag"),
        ...(expose.includes("etag") ? {} : { detail: 'Add "ETag" to ExposeHeaders in the CORS rule' }),
      });
    });
  }
  if (uploaded) {
    await run("verify", "Upload verification (object size)", async () => {
      const head = await adapter.headObject(key);
      if (!head || head.sizeBytes !== Buffer.byteLength(body)) throw new Error("Stored object not found or wrong size");
    });
    await run("read", "Content check (ranged read)", async () => {
      const prefix = new TextDecoder().decode(await adapter.readObjectPrefix(key, 13));
      if (prefix !== body.slice(0, 13)) throw new Error("Unexpected content");
    });
    let signedGet: string | undefined;
    await run("download", "Download with a short-lived pre-signed URL", async () => {
      const get = await adapter.presignGet(key, { expiresInSeconds: 60, contentDisposition: 'attachment; filename="test.txt"', contentType: "application/octet-stream" });
      signedGet = get.url;
      const res = await opts.fetch(get.url);
      if (!res.ok) throw new Error(`Storage returned HTTP ${res.status}`);
      if ((await res.text()) !== body) throw new Error("Downloaded content differs");
    });
    if (signedGet) {
      await run("private", "Bucket is private (unsigned request refused)", async () => {
        const unsigned = new URL(signedGet!);
        unsigned.search = "";
        const res = await opts.fetch(unsigned.toString());
        if (res.ok) throw new Error("The object could be read without a signature - make the bucket private");
        return `HTTP ${res.status}`;
      });
    }
  }
  if (reachable) {
    await run("multipart", "Multipart uploads (large files)", async () => {
      const id = await adapter.createMultipartUpload(`${key}-multipart`, { contentType: "application/octet-stream" });
      await adapter.abortMultipartUpload(`${key}-multipart`, id);
    });
  }
  if (uploaded) {
    await run("delete", "Delete (needed for document removal)", () => adapter.deleteObject(key));
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checkedAt: new Date().toISOString(), checks };
}
