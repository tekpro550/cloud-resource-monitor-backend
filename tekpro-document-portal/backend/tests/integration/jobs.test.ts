import { beforeEach, describe, expect, it } from "vitest";
import { cleanupExpiredUploads, pruneAuthRecords } from "../../src/jobs/cleanupUploads.js";
import { withJobLock } from "../../src/jobs/jobLock.js";
import { reconcileStorage } from "../../src/jobs/reconcile.js";
import { runMaintenance } from "../../src/jobs/scheduler.js";
import { api, createTestApp, login, prisma, resetDb, seedTwoTenants, type Seed, type TestHarness } from "../helpers/testApp.js";

describe("maintenance jobs", () => {
  let h: TestHarness;
  let seed: Seed;

  beforeEach(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
  });

  it("expires abandoned uploads, aborting multipart uploads and removing partial objects", async () => {
    const staff = await login(h.app, "staff@tekpro.test");
    const single = await api(staff).post(`/api/v1/customers/${seed.customers.antrix.id}/uploads/initiate`, {
      folderId: seed.folders.contracts.id,
      filename: "abandoned.pdf",
      sizeBytes: 10,
    });
    const multi = await api(staff).post(`/api/v1/customers/${seed.customers.antrix.id}/uploads/initiate`, {
      folderId: seed.folders.contracts.id,
      filename: "abandoned.zip",
      sizeBytes: 20 * 1024 * 1024,
    });
    const singleKey = (await prisma().document.findUniqueOrThrow({ where: { id: single.body.data.documentId } })).objectKey;
    h.storage.putObject(singleKey, "partial");
    const multiSession = await prisma().uploadSession.findUniqueOrThrow({ where: { id: multi.body.data.uploadId } });

    expect(await cleanupExpiredUploads(h.services)).toEqual({ expired: 0, failed: 0 });
    await prisma().uploadSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await cleanupExpiredUploads(h.services)).toEqual({ expired: 2, failed: 0 });

    expect(h.storage.objects.has(singleKey)).toBe(false);
    expect(h.storage.hasMultipart(multiSession.storageUploadId!)).toBe(false);
    const docs = await prisma().document.findMany({ where: { id: { in: [single.body.data.documentId, multi.body.data.documentId] } } });
    expect(docs.map((d) => d.status)).toEqual(["UPLOAD_FAILED", "UPLOAD_FAILED"]);
    expect(await prisma().auditLog.count({ where: { action: "document.upload.expired" } })).toBe(2);
  });

  it("keeps a session for retry when storage cleanup fails", async () => {
    const staff = await login(h.app, "staff@tekpro.test");
    const init = await api(staff).post(`/api/v1/customers/${seed.customers.antrix.id}/uploads/initiate`, {
      folderId: seed.folders.contracts.id,
      filename: "x.pdf",
      sizeBytes: 10,
    });
    await prisma().uploadSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    h.storage.failNext("deleteObject");
    expect(await cleanupExpiredUploads(h.services)).toEqual({ expired: 0, failed: 1 });
    expect((await prisma().uploadSession.findUniqueOrThrow({ where: { id: init.body.data.uploadId } })).status).toBe("INITIATED");
    expect(await cleanupExpiredUploads(h.services)).toEqual({ expired: 1, failed: 0 });
  });

  it("reconciliation reports orphans and missing objects without changing anything", async () => {
    const orphanKey = `customers/${seed.customers.antrix.id}/documents/${crypto.randomUUID()}`;
    h.storage.putObject(orphanKey, "orphan");
    h.storage.objects.get(orphanKey)!.lastModified = new Date(Date.now() - 48 * 3600 * 1000);
    h.storage.objects.delete(seed.docs.contract.objectKey);

    const report = await reconcileStorage(h.services, { fix: false });
    expect(report.orphanObjects).toEqual([orphanKey]);
    expect(report.missingObjects).toEqual([seed.docs.contract.id]);
    expect(report.removed).toBe(0);
    expect(h.storage.objects.has(orphanKey)).toBe(true);
    expect((await prisma().document.findUniqueOrThrow({ where: { id: seed.docs.contract.id } })).status).toBe("AVAILABLE");
  });

  it("reconciliation with --fix removes old orphans, keeps recent ones, and flags missing objects", async () => {
    const oldOrphan = `customers/${seed.customers.antrix.id}/documents/${crypto.randomUUID()}`;
    const recentOrphan = `customers/${seed.customers.antrix.id}/documents/${crypto.randomUUID()}`;
    h.storage.putObject(oldOrphan, "old");
    h.storage.objects.get(oldOrphan)!.lastModified = new Date(Date.now() - 48 * 3600 * 1000);
    h.storage.putObject(recentOrphan, "in-flight");
    h.storage.objects.delete(seed.docs.contract.objectKey);

    const report = await reconcileStorage(h.services, { fix: true });
    expect(report.removed).toBe(1);
    expect(report.markedMissing).toBe(1);
    expect(h.storage.objects.has(oldOrphan)).toBe(false);
    expect(h.storage.objects.has(recentOrphan)).toBe(true);
    expect((await prisma().document.findUniqueOrThrow({ where: { id: seed.docs.contract.id } })).status).toBe("MISSING_OBJECT");
    // Missing documents disappear for customers but stay visible to staff.
    const admin = await login(h.app, "admin@antrix.test");
    expect((await api(admin).get(`/api/v1/documents/${seed.docs.contract.id}`)).status).toBe(404);
    const staff = await login(h.app, "staff@tekpro.test");
    const missing = await api(staff).get(`/api/v1/customers/${seed.customers.antrix.id}/documents?status=MISSING_OBJECT`);
    expect(missing.body.data.items).toHaveLength(1);
  });

  it("prunes expired sessions and used password tokens", async () => {
    await login(h.app, "staff@tekpro.test");
    await prisma().session.updateMany({ data: { expiresAt: new Date(Date.now() - 8 * 86400_000) } });
    expect((await pruneAuthRecords(h.services)).sessions).toBe(1);
  });

  it("job locks prevent concurrent runs", async () => {
    let inner: unknown;
    const outer = await withJobLock(prisma(), "test-lock", 60, async () => {
      inner = await withJobLock(prisma(), "test-lock", 60, async () => "ran");
      return "outer";
    });
    expect(outer).toBe("outer");
    expect(inner).toBe("LOCKED");
    expect(await withJobLock(prisma(), "test-lock", 60, async () => "again")).toBe("again");
    expect(await runMaintenance(h.services)).toMatchObject({ uploads: { expired: 0 }, purge: { purged: 0 } });
  });
});
