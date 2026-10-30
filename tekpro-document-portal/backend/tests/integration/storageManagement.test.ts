import { beforeEach, describe, expect, it } from "vitest";
import { api, createTestApp, login, prisma, resetDb, seedTwoTenants, type LoggedIn, type Seed, type TestHarness } from "../helpers/testApp.js";

const accessKeyConnector = {
  provider: "AWS_S3",
  bucket: "antrix-original",
  region: "ap-south-1",
  authType: "ACCESS_KEY",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("storage limits, usage and bucket management", () => {
  let h: TestHarness;
  let seed: Seed;
  let sa: LoggedIn;
  let staff: LoggedIn;
  let antrixAdmin: LoggedIn;
  const antrix = () => seed.customers.antrix.id;
  const usageUrl = (id = antrix()) => `/api/v1/customers/${id}/storage-usage`;
  const bucketUrl = () => `/api/v1/customers/${antrix()}/storage-connector/bucket`;
  const initiate = (who: LoggedIn, sizeBytes: number, filename = "Big.pdf") =>
    api(who).post(`/api/v1/customers/${antrix()}/uploads/initiate`, { folderId: seed.folders.contracts.id, filename, sizeBytes });

  beforeEach(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
    sa = await login(h.app, "super@tekpro.test");
    staff = await login(h.app, "staff@tekpro.test");
    antrixAdmin = await login(h.app, "admin@antrix.test");
  });

  describe("storage limit", () => {
    it("shows used and available space to the Super Admin, assigned staff and the Customer Admin", async () => {
      const before = await api(sa).get(usageUrl());
      expect(before.body.data).toMatchObject({ quotaBytes: null, availableBytes: null, location: { mode: "PLATFORM" } });
      const used = before.body.data.usedBytes as number;
      expect(used).toBeGreaterThan(0);

      const set = await api(sa).patch(`/api/v1/customers/${antrix()}`, { storageQuotaBytes: used + 1000 });
      expect(set.body.data.storageQuotaBytes).toBe(used + 1000);
      for (const who of [sa, staff, antrixAdmin]) {
        const res = await api(who).get(usageUrl());
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ quotaBytes: used + 1000, availableBytes: 1000, usedBytes: used });
      }
      const audit = await prisma().auditLog.findFirstOrThrow({ where: { action: "customer.storage_quota_changed" } });
      expect(audit.metadata).toMatchObject({ fromBytes: null, toBytes: used + 1000 });
    });

    it("hides usage from other organisations and from customer users", async () => {
      expect((await api(antrixAdmin).get(usageUrl(seed.customers.beta.id))).status).toBe(404);
      const user = await login(h.app, "user@antrix.test");
      expect((await api(user).get(usageUrl())).status).toBe(403);
    });

    it("only the Super Admin can set the limit, and only to a positive whole number of bytes", async () => {
      expect((await api(staff).patch(`/api/v1/customers/${antrix()}`, { storageQuotaBytes: 10 })).status).toBe(403);
      expect((await api(sa).patch(`/api/v1/customers/${antrix()}`, { storageQuotaBytes: 0 })).status).toBe(400);
      expect((await api(sa).patch(`/api/v1/customers/${antrix()}`, { storageQuotaBytes: 1.5 })).status).toBe(400);
    });

    it("refuses uploads beyond the limit, counting uploads in progress", async () => {
      const used = (await api(sa).get(usageUrl())).body.data.usedBytes as number;
      await api(sa).patch(`/api/v1/customers/${antrix()}`, { storageQuotaBytes: used + 100 });
      expect((await initiate(staff, 60, "First.pdf")).status).toBe(201);
      const second = await initiate(staff, 60, "Second.pdf");
      expect(second.status).toBe(413);
      expect(second.body.error).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", details: { availableBytes: 40, requestedBytes: 60 } });
      await api(sa).patch(`/api/v1/customers/${antrix()}`, { storageQuotaBytes: null });
      expect((await initiate(staff, 60, "Second.pdf")).status).toBe(201);
    });

    it("concurrent uploads cannot together exceed the limit", async () => {
      const used = (await api(sa).get(usageUrl())).body.data.usedBytes as number;
      await api(sa).patch(`/api/v1/customers/${antrix()}`, { storageQuotaBytes: used + 100 });
      const results = await Promise.all([1, 2, 3, 4].map((n) => initiate(staff, 60, `Parallel ${n}.pdf`)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 413)).toHaveLength(3);
    });
  });

  describe("buckets in the customer's own account", () => {
    const connect = async () => {
      expect((await api(sa).put(`/api/v1/customers/${antrix()}/storage-connector`, accessKeyConnector)).status).toBe(201);
    };

    it("requires a connection to the customer's AWS account first", async () => {
      const res = await api(sa).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "ap-south-1" });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/connect this customer's AWS account/);
    });

    it("the Super Admin creates a private bucket, switches the connection to it and verifies it", async () => {
      await connect();
      const res = await api(sa).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "eu-west-1" });
      expect(res.status).toBe(201);
      expect(res.body.data.connector).toMatchObject({ bucket: "tekpro-antrix-docs", region: "eu-west-1", status: "ACTIVE" });
      expect(res.body.data.result.ok).toBe(true);
      expect(h.connectorStorage.createdBucket).toEqual({ region: "eu-west-1", corsOrigin: "http://portal.test" });
      const audit = await prisma().auditLog.findFirstOrThrow({ where: { action: "storage_connector.bucket_created", outcome: "SUCCESS" } });
      expect(audit.metadata).toMatchObject({ bucket: "tekpro-antrix-docs", previousBucket: "antrix-original" });
      const usage = await api(antrixAdmin).get(usageUrl());
      expect(usage.body.data.location).toMatchObject({ mode: "CUSTOMER", bucket: "tekpro-antrix-docs" });
    });

    it("the Customer Admin can create and delete their own bucket", async () => {
      await connect();
      const usage = await api(antrixAdmin).get(usageUrl());
      expect(usage.body.data.bucketManagement).toEqual({ allowed: true, available: true, bucketPrefix: "tekpro-antrix-", documentsInBucket: 0 });
      expect((await api(antrixAdmin).post(bucketUrl(), { bucket: "tekpro-antrix-files", region: "ap-south-1" })).status).toBe(201);
      const del = await api(antrixAdmin).delete(bucketUrl(), { confirmBucket: "tekpro-antrix-files" });
      expect(del.status).toBe(200);
      expect(del.body.data).toEqual({ deleted: "tekpro-antrix-files", storage: "PLATFORM" });
      expect(h.connectorStorage.bucketDeleted).toBe(true);
      expect(await prisma().storageConnector.count()).toBe(0);
    });

    it("bucket names must use the customer's prefix, and taken names are reported", async () => {
      await connect();
      const wrong = await api(sa).post(bucketUrl(), { bucket: "someone-elses-bucket", region: "ap-south-1" });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.message).toContain('"tekpro-antrix-"');
      expect((await api(sa).post(bucketUrl(), { bucket: "Tekpro_Antrix", region: "ap-south-1" })).status).toBe(400);
      h.connectorStorage.bucketExists = true;
      const exists = await api(sa).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "ap-south-1" });
      expect(exists.status).toBe(409);
      expect((await prisma().storageConnector.findFirstOrThrow()).bucket).toBe("antrix-original");
    });

    it("access denied by the customer's role explains the policy that is needed", async () => {
      await connect();
      h.connectorStorage.failNext("createBucket", "ACCESS_DENIED");
      const res = await api(sa).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "ap-south-1" });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/bucket management policy/);
    });

    it("a bucket holding documents can be neither replaced nor deleted", async () => {
      await connect();
      await api(sa).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "ap-south-1" });
      expect((await initiate(staff, 20, "Kept.pdf")).status).toBe(201);
      expect((await api(sa).post(bucketUrl(), { bucket: "tekpro-antrix-new", region: "ap-south-1" })).status).toBe(409);
      const del = await api(sa).delete(bucketUrl(), { confirmBucket: "tekpro-antrix-docs" });
      expect(del.status).toBe(409);
      expect(del.body.error.details).toEqual({ documents: 1 });
      expect(h.connectorStorage.bucketDeleted).toBe(false);
    });

    it("deletion needs the bucket name typed, and refuses buckets with files the portal did not create", async () => {
      await connect();
      await api(sa).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "ap-south-1" });
      expect((await api(sa).delete(bucketUrl(), { confirmBucket: "wrong" })).status).toBe(400);
      h.connectorStorage.objects.set("other-team/report.pdf", { body: new Uint8Array(1), contentType: "x", etag: "e", lastModified: new Date() });
      const res = await api(sa).delete(bucketUrl(), { confirmBucket: "tekpro-antrix-docs" });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/not created by the portal/);
      expect(await prisma().storageConnector.count()).toBe(1);
    });

    it("Customer Admins cannot manage buckets when the setting is off; other roles never can", async () => {
      await connect();
      await api(sa).patch("/api/v1/settings", { customerAdminCanManageStorage: false });
      const res = await api(antrixAdmin).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "ap-south-1" });
      expect(res.status).toBe(403);
      expect((await api(antrixAdmin).get(usageUrl())).body.data.bucketManagement.allowed).toBe(false);
      expect((await api(staff).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "ap-south-1" })).status).toBe(403);
      const user = await login(h.app, "user@antrix.test");
      expect((await api(user).delete(bucketUrl(), { confirmBucket: "antrix-original" })).status).toBe(403);
      const betaAdmin = await login(h.app, "admin@beta.test");
      await api(sa).patch("/api/v1/settings", { customerAdminCanManageStorage: true });
      expect((await api(betaAdmin).post(bucketUrl(), { bucket: "tekpro-antrix-docs", region: "ap-south-1" })).status).toBe(404);
    });
  });

  describe("operational settings", () => {
    const opUrl = "/api/v1/settings/operational";

    it("the Super Admin changes limits at runtime and can reset them to the server default", async () => {
      const before = (await api(sa).get("/api/v1/settings")).body.data.operational;
      expect(before.overridden).toEqual([]);
      const res = await api(sa).patch(opUrl, { uploadAllowedExtensions: ["pdf", "docx"], downloadUrlTtlSeconds: 120 });
      expect(res.status).toBe(200);
      expect(res.body.data.operational.values).toMatchObject({ uploadAllowedExtensions: ["docx", "pdf"], downloadUrlTtlSeconds: 120 });
      expect(res.body.data.operational.overridden).toEqual(["downloadUrlTtlSeconds", "uploadAllowedExtensions"]);
      // Applied immediately.
      expect((await initiate(staff, 10, "Sheet.xlsx")).status).toBe(415);
      const audit = await prisma().auditLog.findFirstOrThrow({ where: { action: "settings.changed" }, orderBy: { createdAt: "desc" } });
      expect(audit.metadata).toMatchObject({ scope: "operational", after: { downloadUrlTtlSeconds: 120 } });

      const reset = await api(sa).patch(opUrl, { uploadAllowedExtensions: null });
      expect(reset.body.data.operational.values.uploadAllowedExtensions).toEqual(before.defaults.uploadAllowedExtensions);
      expect(reset.body.data.operational.overridden).toEqual(["downloadUrlTtlSeconds"]);
      expect((await initiate(staff, 10, "Sheet.xlsx")).status).toBe(201);
    });

    it("overrides are stored and loaded by every app instance", async () => {
      await api(sa).patch(opUrl, { deletedDocumentRetentionDays: 7 });
      const other = createTestApp();
      expect(other.services.config.deletedDocumentRetentionDays).toBe(30);
      await other.services.operational.refresh();
      expect(other.services.config.deletedDocumentRetentionDays).toBe(7);
    });

    it("rejects unsafe or inconsistent values", async () => {
      expect((await api(sa).patch(opUrl, { uploadAllowedExtensions: ["pdf", "exe"] })).status).toBe(400);
      expect((await api(sa).patch(opUrl, { downloadUrlTtlSeconds: 3600 })).status).toBe(400);
      expect((await api(sa).patch(opUrl, { uploadPartSizeBytes: 1024 })).status).toBe(400);
      const idle = await api(sa).patch(opUrl, { sessionTtlSeconds: 600, sessionIdleTimeoutSeconds: 1200 });
      expect(idle.status).toBe(400);
      expect(idle.body.error.message).toMatch(/idle sign-out/);
      expect((await api(sa).patch(opUrl, { unknownSetting: 1 })).status).toBe(400);
      expect((await api(staff).patch(opUrl, { downloadUrlTtlSeconds: 120 })).status).toBe(403);
    });
  });
});
