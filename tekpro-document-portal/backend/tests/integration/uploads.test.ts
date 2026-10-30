import { beforeEach, describe, expect, it } from "vitest";
import { choosePartSize } from "../../src/modules/uploads/uploads.routes.js";
import { api, createTestApp, login, prisma, resetDb, seedTwoTenants, type LoggedIn, type Seed, type TestHarness } from "../helpers/testApp.js";

const PDF = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

describe("uploads", () => {
  let h: TestHarness;
  let seed: Seed;
  let staff: LoggedIn;
  const initiate = (body: object) => api(staff).post(`/api/v1/customers/${seed.customers.antrix.id}/uploads/initiate`, body);
  const keyOf = async (documentId: string) => (await prisma().document.findUniqueOrThrow({ where: { id: documentId } })).objectKey;

  beforeEach(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
    staff = await login(h.app, "staff@tekpro.test");
  });

  it("single-part upload: initiate -> direct PUT -> verified completion -> AVAILABLE", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Statement.pdf", sizeBytes: PDF.length });
    expect(init.status).toBe(201);
    expect(init.body.data.mode).toBe("SINGLE");
    expect(init.body.data.upload.method).toBe("PUT");
    expect(init.body.data.upload.headers["Content-Type"]).toBe("application/pdf");
    expect(init.body.data).not.toHaveProperty("objectKey");

    const pending = await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } });
    expect(pending.status).toBe("PENDING_UPLOAD");
    expect(pending.objectKey).toBe(`customers/${seed.customers.antrix.id}/documents/${pending.id}`);

    // Pending documents are invisible to customers.
    const admin = await login(h.app, "admin@antrix.test");
    expect((await api(admin).get(`/api/v1/documents/${pending.id}`)).status).toBe(404);

    h.storage.putObject(pending.objectKey, PDF);
    const done = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("AVAILABLE");
    expect(done.body.data.sizeBytes).toBe(PDF.length);

    // Completion is idempotent.
    const again = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(again.status).toBe(200);
    expect(await prisma().auditLog.count({ where: { action: "document.upload.completed" } })).toBe(1);
    expect(await prisma().auditLog.count({ where: { action: "document.upload.initiated" } })).toBe(1);
  });

  it("refuses completion when the object was never uploaded, and allows a retry afterwards", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Late.pdf", sizeBytes: PDF.length });
    const early = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("UPLOAD_VERIFICATION_FAILED");
    expect((await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } })).status).toBe("PENDING_UPLOAD");

    h.storage.putObject(await keyOf(init.body.data.documentId), PDF);
    expect((await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(200);
  });

  it("rejects an object whose size differs from the declared size and removes it", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Wrong.pdf", sizeBytes: 999 });
    const key = await keyOf(init.body.data.documentId);
    h.storage.putObject(key, PDF);
    const res = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(res.status).toBe(422);
    expect(h.storage.objects.has(key)).toBe(false);
    expect((await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } })).status).toBe("UPLOAD_FAILED");
  });

  it("rejects content that does not match the file extension (e.g. an executable named .pdf)", async () => {
    const exe = new Uint8Array(512);
    exe.set([0x4d, 0x5a, 0x90, 0x00]);
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "invoice.pdf", sizeBytes: exe.length });
    h.storage.putObject(await keyOf(init.body.data.documentId), exe);
    const res = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("FILE_TYPE_NOT_ALLOWED");
  });

  it("rejects a PNG disguised as a text file", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "notes.txt", sizeBytes: PNG.length });
    h.storage.putObject(await keyOf(init.body.data.documentId), PNG);
    expect((await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(422);
  });

  it("accepts plain text files without a binary signature", async () => {
    const csv = "a,b,c\n1,2,3\n";
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "data.csv", sizeBytes: csv.length });
    h.storage.putObject(await keyOf(init.body.data.documentId), csv);
    expect((await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(200);
  });

  it("validates file type, size and name at initiation", async () => {
    const exe = await initiate({ folderId: seed.folders.contracts.id, filename: "setup.exe", sizeBytes: 10 });
    expect(exe.status).toBe(415);
    const big = await initiate({ folderId: seed.folders.contracts.id, filename: "big.pdf", sizeBytes: 2 * 1024 ** 3 });
    expect(big.status).toBe(413);
    for (const filename of ["../../etc/passwd.pdf", "a/b.pdf", "con.pdf", "evil‮fdp.exe", ""]) {
      const res = await initiate({ folderId: seed.folders.contracts.id, filename, sizeBytes: 10 });
      expect(res.status, filename).toBe(400);
    }
    expect(await prisma().document.count({ where: { status: "PENDING_UPLOAD" } })).toBe(0);
  });

  it("supports duplicate display names without overwriting: each upload gets its own object key", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Master Contract.pdf", sizeBytes: PDF.length });
      h.storage.putObject(await keyOf(init.body.data.documentId), PDF);
      expect((await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(200);
      ids.push(init.body.data.documentId);
    }
    const docs = await prisma().document.findMany({ where: { displayName: "Master Contract.pdf", status: "AVAILABLE" } });
    expect(docs).toHaveLength(3);
    expect(new Set(docs.map((d) => d.objectKey)).size).toBe(3);
    expect(h.storage.objects.has(seed.docs.contract.objectKey)).toBe(true);
  });

  it("multipart upload: parts are signed on demand and completion verifies size", async () => {
    const part = 5 * 1024 * 1024;
    const size = part * 2 + 100;
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Large Archive.zip", sizeBytes: size });
    expect(init.status).toBe(201);
    expect(init.body.data.mode).toBe("MULTIPART");
    expect(init.body.data.partSize).toBe(part);
    expect(init.body.data.partCount).toBe(3);

    const urls = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/parts`, { partNumbers: [1, 2, 3] });
    expect(urls.status).toBe(200);
    expect(urls.body.data.parts).toHaveLength(3);
    const outOfRange = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/parts`, { partNumbers: [4] });
    expect(outOfRange.status).toBe(400);

    const session = await prisma().uploadSession.findUniqueOrThrow({ where: { id: init.body.data.uploadId } });
    const zipHeader = new Uint8Array(part);
    zipHeader.set([0x50, 0x4b, 0x03, 0x04]);
    const etags = [
      h.storage.uploadPart(session.storageUploadId!, 1, zipHeader),
      h.storage.uploadPart(session.storageUploadId!, 2, new Uint8Array(part)),
      h.storage.uploadPart(session.storageUploadId!, 3, new Uint8Array(100)),
    ];

    const missing = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`, {
      parts: [{ partNumber: 1, etag: etags[0] }],
    });
    expect(missing.status).toBe(400);

    const wrongEtag = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`, {
      parts: etags.map((etag, i) => ({ partNumber: i + 1, etag: i === 2 ? "bogus" : etag })),
    });
    expect(wrongEtag.status).toBe(400);
    expect(wrongEtag.body.error.code).toBe("UPLOAD_VERIFICATION_FAILED");

    const done = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`, {
      parts: etags.map((etag, i) => ({ partNumber: i + 1, etag: `"${etag}"` })),
    });
    expect(done.status).toBe(200);
    expect(done.body.data.sizeBytes).toBe(size);
    expect(done.body.data.status).toBe("AVAILABLE");
  });

  it("chooses part sizes that respect the 10,000 part limit", () => {
    const fiveGiB = 5 * 1024 ** 3;
    expect(choosePartSize(fiveGiB, 64 * 1024 ** 2)).toBe(64 * 1024 ** 2);
    const huge = 1024 ** 4;
    expect(Math.ceil(huge / choosePartSize(huge, 64 * 1024 ** 2))).toBeLessThanOrEqual(10_000);
    expect(choosePartSize(10, 1)).toBe(5 * 1024 ** 2);
  });

  it("abort removes partial data and marks the document failed", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Big.zip", sizeBytes: 11 * 1024 * 1024 });
    const session = await prisma().uploadSession.findUniqueOrThrow({ where: { id: init.body.data.uploadId } });
    h.storage.uploadPart(session.storageUploadId!, 1, new Uint8Array(10));
    expect((await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/abort`)).status).toBe(204);
    expect(h.storage.hasMultipart(session.storageUploadId!)).toBe(false);
    expect((await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } })).status).toBe("UPLOAD_FAILED");
    expect((await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(409);
  });

  it("refuses completion of an expired session and cleans it up", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Old.pdf", sizeBytes: PDF.length });
    h.storage.putObject(await keyOf(init.body.data.documentId), PDF);
    await prisma().uploadSession.update({ where: { id: init.body.data.uploadId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(res.status).toBe(410);
    expect(h.storage.objects.size).toBe(6);
    const session = await prisma().uploadSession.findUniqueOrThrow({ where: { id: init.body.data.uploadId } });
    expect(session.status).toBe("EXPIRED");
  });

  it("a transient storage failure during completion is retry-safe", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Flaky.pdf", sizeBytes: PDF.length });
    h.storage.putObject(await keyOf(init.body.data.documentId), PDF);
    h.storage.failNext("headObject", "UNAVAILABLE");
    const first = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(first.status).toBe(503);
    expect(first.body.error.code).toBe("STORAGE_UNAVAILABLE");
    expect(JSON.stringify(first.body)).not.toMatch(/Simulated|memory/);
    const second = await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(second.status).toBe(200);
  });

  it("a storage failure at initiation marks the pending document failed", async () => {
    h.storage.failNext("presignPut", "ACCESS_DENIED");
    const res = await initiate({ folderId: seed.folders.contracts.id, filename: "Denied.pdf", sizeBytes: 10 });
    expect(res.status).toBe(503);
    const doc = await prisma().document.findFirstOrThrow({ where: { displayName: "Denied.pdf" } });
    expect(doc.status).toBe("UPLOAD_FAILED");
  });

  it("only the user who started an upload (or a Super Admin) can complete it", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Mine.pdf", sizeBytes: PDF.length });
    h.storage.putObject(await keyOf(init.body.data.documentId), PDF);
    const sa = await login(h.app, "super@tekpro.test");
    await api(sa).post(`/api/v1/customers/${seed.customers.antrix.id}/assignments`, { userId: seed.users.otherStaff.id });
    const other = await login(h.app, "staff2@tekpro.test");
    expect((await api(other).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(404);
    expect((await api(sa).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(200);
  });

  it("an unassigned staff member cannot complete an upload started before the assignment was removed", async () => {
    const init = await initiate({ folderId: seed.folders.contracts.id, filename: "Revoked.pdf", sizeBytes: PDF.length });
    h.storage.putObject(await keyOf(init.body.data.documentId), PDF);
    await prisma().tekproUserCustomerAssignment.deleteMany({ where: { userId: staff.userId } });
    expect((await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(404);
  });
});

describe("downloads", () => {
  let h: TestHarness;
  let seed: Seed;

  beforeEach(async () => {
    await resetDb();
    h = createTestApp({ DOWNLOAD_URL_TTL_SECONDS: "300" });
    seed = await seedTwoTenants(h.storage);
  });

  it("issues a short-lived attachment URL and audits the link issuance without the URL", async () => {
    const user = await login(h.app, "user@antrix.test");
    const before = Date.now();
    const res = await api(user).get(`/api/v1/documents/${seed.docs.report.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.data.filename).toBe("Annual Report.pdf");
    const expiresAt = new Date(res.body.data.expiresAt).getTime();
    expect(expiresAt - before).toBeLessThanOrEqual(301_000);
    expect(expiresAt - before).toBeGreaterThan(290_000);
    expect(res.body.data.url).toContain("X-Amz-Expires=300");
    expect(decodeURIComponent(res.body.data.url)).toContain("attachment;");

    const audit = await prisma().auditLog.findFirstOrThrow({ where: { action: "document.download.link_issued" } });
    expect(audit.actorUserId).toBe(user.userId);
    expect(audit.customerId).toBe(seed.customers.antrix.id);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(serialized).not.toContain("memory-storage");
  });

  it("does not issue links for documents that are not available", async () => {
    await prisma().document.update({ where: { id: seed.docs.contract.id }, data: { status: "MISSING_OBJECT" } });
    const staff = await login(h.app, "staff@tekpro.test");
    expect((await api(staff).get(`/api/v1/documents/${seed.docs.contract.id}/download`)).status).toBe(409);
  });

  it("returns a safe error when storage cannot sign the URL", async () => {
    const staff = await login(h.app, "staff@tekpro.test");
    h.storage.failNext("presignGet", "UNAVAILABLE");
    const res = await api(staff).get(`/api/v1/documents/${seed.docs.report.id}/download`);
    expect(res.status).toBe(503);
    expect(res.body.data).toBeUndefined();
  });

  it("returns 404 for unknown and malformed document ids", async () => {
    const staff = await login(h.app, "staff@tekpro.test");
    expect((await api(staff).get(`/api/v1/documents/${crypto.randomUUID()}/download`)).status).toBe(404);
    expect((await api(staff).get(`/api/v1/documents/not-a-uuid/download`)).status).toBe(400);
  });
});
