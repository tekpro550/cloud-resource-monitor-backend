/**
 * Integration tests for S3StorageAdapter against a real S3-compatible endpoint.
 *
 * Configure with STORAGE_IT_* variables (see docs/TESTING.md). They run against:
 *   - a local emulator (e.g. moto_server) for signing/multipart flow checks, or
 *   - a dedicated, NON-PRODUCTION Lightsail bucket. Set STORAGE_IT_STRICT=true to
 *     additionally assert provider-enforced behaviour (private bucket, URL expiry,
 *     signed-header enforcement) that emulators do not implement.
 * All objects are written under a unique `_integration-tests/` prefix and deleted.
 */
import { randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { RecordingMailer } from "../../src/modules/mail/mailer.js";
import { S3StorageAdapter } from "../../src/storage/s3Storage.js";
import { api, createFolder, createUser, login, prisma, resetDb, testConfig } from "../helpers/testApp.js";

const env = process.env;
const configured = !!(env.STORAGE_IT_BUCKET && env.STORAGE_IT_ACCESS_KEY_ID && env.STORAGE_IT_SECRET_ACCESS_KEY && env.STORAGE_IT_REGION);
const strict = env.STORAGE_IT_STRICT === "true";

const storageEnv = () => ({
  STORAGE_DRIVER: "s3",
  STORAGE_ENDPOINT: env.STORAGE_IT_ENDPOINT ?? "",
  STORAGE_REGION: env.STORAGE_IT_REGION!,
  STORAGE_BUCKET: env.STORAGE_IT_BUCKET!,
  STORAGE_ACCESS_KEY_ID: env.STORAGE_IT_ACCESS_KEY_ID!,
  STORAGE_SECRET_ACCESS_KEY: env.STORAGE_IT_SECRET_ACCESS_KEY!,
  STORAGE_FORCE_PATH_STYLE: env.STORAGE_IT_FORCE_PATH_STYLE ?? "false",
});

describe.skipIf(!configured)("S3StorageAdapter (real S3-compatible endpoint)", () => {
  const prefix = `_integration-tests/${randomUUID()}`;
  let storage: S3StorageAdapter;
  const written: string[] = [];

  beforeAll(async () => {
    const e = storageEnv();
    const cfg = testConfig(Object.fromEntries(Object.entries(e).filter(([, v]) => v !== "")));
    if (env.STORAGE_IT_CREATE_BUCKET === "true") {
      const client = new S3Client({
        region: e.STORAGE_REGION,
        endpoint: e.STORAGE_ENDPOINT || undefined,
        forcePathStyle: e.STORAGE_FORCE_PATH_STYLE === "true",
        credentials: { accessKeyId: e.STORAGE_ACCESS_KEY_ID, secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY },
      });
      await client.send(new CreateBucketCommand({ Bucket: e.STORAGE_BUCKET })).catch(() => undefined);
    }
    storage = new S3StorageAdapter(cfg.storage);
  });

  afterAll(async () => {
    for (const key of written) await storage?.deleteObject(key).catch(() => undefined);
  });

  it("reaches the bucket", async () => {
    await storage.checkConnectivity();
  });

  it("uploads with a pre-signed PUT, verifies with HEAD and a ranged GET", async () => {
    const key = `${prefix}/single`;
    written.push(key);
    const body = "%PDF-1.7 integration";
    const put = await storage.presignPut(key, { contentType: "application/pdf", contentLength: body.length, expiresInSeconds: 120 });
    expect(put.url).not.toContain("x-amz-checksum");
    const res = await fetch(put.url, { method: "PUT", headers: put.headers, body });
    expect(res.status).toBe(200);
    const head = await storage.headObject(key);
    expect(head?.sizeBytes).toBe(body.length);
    expect(new TextDecoder().decode(await storage.readObjectPrefix(key, 8))).toBe("%PDF-1.7");
  });

  it("returns null from HEAD for a missing object", async () => {
    expect(await storage.headObject(`${prefix}/does-not-exist`)).toBeNull();
  });

  it("issues GET URLs that force an attachment download", async () => {
    const key = `${prefix}/download`;
    written.push(key);
    const put = await storage.presignPut(key, { contentType: "text/plain", contentLength: 5, expiresInSeconds: 60 });
    await fetch(put.url, { method: "PUT", headers: put.headers, body: "hello" });
    const get = await storage.presignGet(key, { expiresInSeconds: 60, contentDisposition: 'attachment; filename="a.txt"', contentType: "application/octet-stream" });
    const res = await fetch(get.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("completes a multipart upload from pre-signed part URLs", async () => {
    const key = `${prefix}/multipart`;
    written.push(key);
    const id = await storage.createMultipartUpload(key, { contentType: "application/zip" });
    const parts = [new Uint8Array(5 * 1024 * 1024).fill(1), new Uint8Array(1234).fill(2)];
    const done: { partNumber: number; etag: string }[] = [];
    for (const [i, data] of parts.entries()) {
      const u = await storage.presignUploadPart(key, id, i + 1, 120);
      const res = await fetch(u.url, { method: "PUT", body: data });
      expect(res.status).toBe(200);
      done.push({ partNumber: i + 1, etag: res.headers.get("etag")! });
    }
    await expect(storage.completeMultipartUpload(key, id, [{ partNumber: 1, etag: '"bogus"' }, done[1]!])).rejects.toMatchObject({
      name: "StorageError",
    });
    await storage.completeMultipartUpload(key, id, done);
    expect((await storage.headObject(key))?.sizeBytes).toBe(5 * 1024 * 1024 + 1234);
  });

  it("aborts multipart uploads", async () => {
    const key = `${prefix}/aborted`;
    const id = await storage.createMultipartUpload(key, { contentType: "application/zip" });
    await storage.abortMultipartUpload(key, id);
    await storage.abortMultipartUpload(key, id); // idempotent
    expect(await storage.headObject(key)).toBeNull();
  });

  it("lists objects under a prefix and deletes them", async () => {
    const listed = await storage.listObjects(`${prefix}/`);
    expect(listed.objects.map((o) => o.key)).toEqual(expect.arrayContaining([`${prefix}/single`]));
    await storage.deleteObject(`${prefix}/single`);
    expect(await storage.headObject(`${prefix}/single`)).toBeNull();
  });

  it.skipIf(!strict)("rejects unsigned reads (bucket is private)", async () => {
    const key = `${prefix}/private`;
    written.push(key);
    const put = await storage.presignPut(key, { contentType: "text/plain", contentLength: 1, expiresInSeconds: 60 });
    await fetch(put.url, { method: "PUT", headers: put.headers, body: "x" });
    const unsigned = new URL((await storage.presignGet(key, { expiresInSeconds: 60, contentDisposition: "attachment", contentType: "text/plain" })).url);
    unsigned.search = "";
    expect((await fetch(unsigned)).status).toBe(403);
  });

  it.skipIf(!strict)("expired pre-signed URLs are refused", async () => {
    const key = `${prefix}/expiry`;
    written.push(key);
    const put = await storage.presignPut(key, { contentType: "text/plain", contentLength: 1, expiresInSeconds: 60 });
    await fetch(put.url, { method: "PUT", headers: put.headers, body: "x" });
    const get = await storage.presignGet(key, { expiresInSeconds: 1, contentDisposition: "attachment", contentType: "text/plain" });
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(get.url)).status).toBe(403);
  });

  it.skipIf(!strict)("a pre-signed PUT cannot be used to upload a different size than authorised", async () => {
    const key = `${prefix}/size`;
    written.push(key);
    const put = await storage.presignPut(key, { contentType: "text/plain", contentLength: 3, expiresInSeconds: 60 });
    const res = await fetch(put.url, { method: "PUT", headers: put.headers, body: "too long" });
    expect(res.ok).toBe(false);
  });
});

describe.skipIf(!configured)("end-to-end upload and download through the API with real storage", () => {
  it("uploads via pre-signed PUT, completes with server verification, downloads via pre-signed GET", async () => {
    await resetDb();
    const config = testConfig(Object.fromEntries(Object.entries(storageEnv()).filter(([, v]) => v !== "")));
    const storage = new S3StorageAdapter(config.storage);
    const { app } = createApp({ config, prisma: prisma(), storage, mailer: new RecordingMailer(), logger: pino({ level: "silent" }) });
    const customer = await prisma().customer.create({ data: { name: "E2E", customerCode: "E2E" } });
    const folder = await createFolder(customer.id, "Inbox");
    await createUser({ email: "sa@e2e.test", role: "SUPER_ADMIN" });
    await createUser({ email: "u@e2e.test", role: "CUSTOMER_ADMIN", customerId: customer.id });
    const sa = await login(app, "sa@e2e.test");

    const body = "%PDF-1.7\n% end-to-end\n%%EOF";
    const init = await api(sa).post(`/api/v1/customers/${customer.id}/uploads/initiate`, { folderId: folder.id, filename: "E2E.pdf", sizeBytes: body.length });
    expect(init.status).toBe(201);
    const put = await fetch(init.body.data.upload.url, { method: "PUT", headers: init.body.data.upload.headers, body });
    expect(put.status).toBe(200);
    const done = await api(sa).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("AVAILABLE");

    const user = await login(app, "u@e2e.test");
    const dl = await api(user).get(`/api/v1/documents/${done.body.data.id}/download`);
    expect(dl.status).toBe(200);
    const file = await fetch(dl.body.data.url);
    expect(await file.text()).toBe(body);
    expect(file.headers.get("content-disposition")).toContain('filename="E2E.pdf"');

    const ready = await request(app).get("/api/v1/health/ready");
    expect(ready.body.checks.storage).toBe("ok");
    await storage.deleteObject(`customers/${customer.id}/documents/${done.body.data.id}`);
  });
});
