/**
 * Storage diagnostics for the configured Lightsail Object Storage bucket.
 *
 *   npm run storage:check            # read-only checks + write/delete probe
 *   npm run storage:check -- --skip-write
 *
 * Verifies: credentials and bucket access (HeadBucket), PutObject/HeadObject/
 * ranged GetObject/DeleteObject on a probe key, pre-signed PUT and GET via HTTP,
 * multipart create/upload/complete, multipart abort, that an unsigned GET is
 * refused (bucket not public), and that a pre-signed URL stops working after it
 * expires. Prints results only; never prints credentials or signed URLs.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfigOrExit } from "../bootstrap.js";
import { S3StorageAdapter } from "../storage/s3Storage.js";
import { storageBrowserOrigin } from "../storage/index.js";

type Result = { check: string; ok: boolean; detail?: string };

async function main() {
  const { values } = parseArgs({ options: { "skip-write": { type: "boolean", default: false }, "skip-expiry": { type: "boolean", default: false } } });
  const config = loadConfigOrExit();
  if (config.storage.driver !== "s3") throw new Error("STORAGE_DRIVER must be s3 for this check");
  const storage = new S3StorageAdapter(config.storage);
  const results: Result[] = [];
  const run = async (check: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      results.push({ check, ok: true, detail: detail || undefined });
    } catch (err) {
      results.push({ check, ok: false, detail: (err as Error).message });
    }
  };

  process.stdout.write(
    `Endpoint: ${config.storage.endpoint ?? "(AWS default for region)"}\nRegion: ${config.storage.region}\nBucket: ${config.storage.bucket}\n` +
      `Path-style: ${config.storage.forcePathStyle}\nBrowser origin (CSP/CORS): ${storageBrowserOrigin(config)}\n\n`,
  );

  await run("HeadBucket (credentials + bucket access)", () => storage.checkConnectivity());

  if (!values["skip-write"]) {
    const key = `_diagnostics/${randomUUID()}`;
    const body = "tekpro-storage-check";
    await run("Pre-signed PUT (browser-style upload)", async () => {
      const put = await storage.presignPut(key, { contentType: "text/plain", contentLength: body.length, expiresInSeconds: 120 });
      const res = await fetch(put.url, { method: "PUT", headers: put.headers, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `ETag exposed to script: ${res.headers.get("etag") ? "yes" : "no (CORS ExposeHeaders not applicable to server-side fetch)"}`;
    });
    await run("HeadObject size verification", async () => {
      const head = await storage.headObject(key);
      if (!head || head.sizeBytes !== body.length) throw new Error(`unexpected head ${JSON.stringify(head)}`);
    });
    await run("Ranged GetObject (content sniffing)", async () => {
      const bytes = await storage.readObjectPrefix(key, 6);
      if (new TextDecoder().decode(bytes) !== body.slice(0, 6)) throw new Error("unexpected range content");
    });
    await run("Pre-signed GET with Content-Disposition", async () => {
      const get = await storage.presignGet(key, { expiresInSeconds: 60, contentDisposition: 'attachment; filename="check.txt"', contentType: "application/octet-stream" });
      const res = await fetch(get.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cd = res.headers.get("content-disposition") ?? "";
      if (!cd.includes("attachment")) throw new Error("Content-Disposition override not honoured");
    });
    await run("Unsigned GET is refused (bucket private)", async () => {
      const origin = storageBrowserOrigin(config)!;
      const url = config.storage.forcePathStyle ? `${origin}/${config.storage.bucket}/${key}` : `${origin}/${key}`;
      const res = await fetch(url);
      if (res.ok) throw new Error("object was readable without a signature - bucket or object is public!");
      return `HTTP ${res.status}`;
    });
    if (!values["skip-expiry"]) {
      await run("Pre-signed URL expires", async () => {
        const get = await storage.presignGet(key, { expiresInSeconds: 1, contentDisposition: "attachment", contentType: "application/octet-stream" });
        await new Promise((r) => setTimeout(r, 2500));
        const res = await fetch(get.url);
        if (res.ok) throw new Error("expired URL still worked");
        return `HTTP ${res.status}`;
      });
    }
    await run("Multipart create/upload/complete", async () => {
      const mkey = `${key}-multipart`;
      const id = await storage.createMultipartUpload(mkey, { contentType: "application/octet-stream" });
      const part1 = new Uint8Array(5 * 1024 * 1024).fill(97);
      const part2 = new Uint8Array(1024).fill(98);
      const etags: { partNumber: number; etag: string }[] = [];
      for (const [i, data] of [part1, part2].entries()) {
        const u = await storage.presignUploadPart(mkey, id, i + 1, 120);
        const res = await fetch(u.url, { method: "PUT", body: data });
        if (!res.ok) throw new Error(`part ${i + 1}: HTTP ${res.status}`);
        etags.push({ partNumber: i + 1, etag: res.headers.get("etag") ?? "" });
      }
      await storage.completeMultipartUpload(mkey, id, etags);
      const head = await storage.headObject(mkey);
      await storage.deleteObject(mkey);
      if (head?.sizeBytes !== part1.length + part2.length) throw new Error("multipart object size mismatch");
    });
    await run("Multipart abort", async () => {
      const id = await storage.createMultipartUpload(`${key}-abort`, { contentType: "application/octet-stream" });
      await storage.abortMultipartUpload(`${key}-abort`, id);
    });
    await run("DeleteObject", () => storage.deleteObject(key));
  }

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail ? ` - ${r.detail}` : ""}\n`);
  }
  process.stdout.write(
    "\nNote: browser uploads additionally require a bucket CORS rule allowing PUT from APP_BASE_URL and exposing the ETag header (see docs/DEPLOYMENT.md).\n",
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err: Error) => {
  process.stderr.write(`Storage check failed: ${err.message}\n`);
  process.exit(1);
});
