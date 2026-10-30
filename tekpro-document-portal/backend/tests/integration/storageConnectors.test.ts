import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeDeletedDocuments } from "../../src/jobs/purgeDeleted.js";
import { reconcileStorage } from "../../src/jobs/reconcile.js";
import { api, createTestApp, login, prisma, resetDb, seedTwoTenants, type LoggedIn, type Seed, type TestHarness } from "../helpers/testApp.js";

const PDF = "%PDF-1.7\n% customer bucket\n%%EOF";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const accessKeyConnector = {
  provider: "AWS_S3",
  bucket: "antrix-documents",
  region: "ap-south-1",
  authType: "ACCESS_KEY",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: SECRET,
};

describe("customer storage connectors", () => {
  let h: TestHarness;
  let seed: Seed;
  let sa: LoggedIn;
  let staff: LoggedIn;
  const url = () => `/api/v1/customers/${seed.customers.antrix.id}/storage-connector`;

  const uploadPdf = async (who: LoggedIn, name = "Statement.pdf") => {
    const init = await api(who).post(`/api/v1/customers/${seed.customers.antrix.id}/uploads/initiate`, {
      folderId: seed.folders.contracts.id,
      filename: name,
      sizeBytes: PDF.length,
    });
    return init;
  };

  const connectAndVerify = async () => {
    expect((await api(sa).put(url(), accessKeyConnector)).status).toBe(201);
    const v = await api(sa).post(`${url()}/verify`);
    expect(v.body.data.result.ok).toBe(true);
  };

  beforeEach(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
    sa = await login(h.app, "super@tekpro.test");
    staff = await login(h.app, "staff@tekpro.test");
  });

  it("customers use platform storage until a connector is configured", async () => {
    const res = await api(sa).get(url());
    expect(res.body.data).toEqual({ mode: "PLATFORM", connector: null });
  });

  it("stores access keys encrypted and never returns or logs the secret", async () => {
    const res = await api(sa).put(url(), accessKeyConnector);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "PENDING_VERIFICATION", secretStored: true, accessKeyIdMasked: "••••••••••••••••MPLE" });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const row = await prisma().storageConnector.findFirstOrThrow();
    expect(row.secretCiphertext).toMatch(/^v1\./);
    expect(row.secretCiphertext).not.toContain(SECRET);
    expect(row.externalId).toMatch(/^tekpro-/);
    const audits = JSON.stringify(await prisma().auditLog.findMany({ where: { action: { startsWith: "storage_connector" } } }));
    expect(audits).not.toContain(SECRET);
    const full = await api(sa).get(url());
    expect(JSON.stringify(full.body)).not.toContain(SECRET);
    expect(full.body.data.setup.permissionsPolicy.Statement[0].Resource).toBe(`arn:aws:s3:::antrix-documents/customers/${seed.customers.antrix.id}/*`);
    expect(full.body.data.setup.corsConfiguration.CORSRules[0].AllowedOrigins).toEqual(["http://portal.test"]);
  });

  it("refuses uploads (no silent fallback to Tekpro storage) until the connector is verified", async () => {
    await api(sa).put(url(), accessKeyConnector);
    const res = await uploadPdf(staff);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/storage connection is not active/);
    expect(await prisma().document.count({ where: { displayName: "Statement.pdf" } })).toBe(0);
  });

  it("verification exercises upload, CORS, download, privacy, multipart and delete", async () => {
    await api(sa).put(url(), accessKeyConnector);
    const res = await api(sa).post(`${url()}/verify`);
    expect(res.status).toBe(200);
    expect(res.body.data.result.checks.map((c: { id: string }) => c.id)).toEqual([
      "access",
      "cors",
      "cors-etag",
      "upload",
      "verify",
      "read",
      "download",
      "private",
      "multipart",
      "delete",
    ]);
    expect(res.body.data.result.ok).toBe(true);
    expect(res.body.data.connector.status).toBe("ACTIVE");
    expect([...h.connectorStorage.objects.keys()]).toEqual([]);
  });

  it("fails verification with a clear reason when the bucket CORS rule is missing", async () => {
    h.connectorStorage.cors = { allowOrigin: null, exposeEtag: false };
    await api(sa).put(url(), accessKeyConnector);
    const res = await api(sa).post(`${url()}/verify`);
    expect(res.body.data.result.ok).toBe(false);
    expect(res.body.data.connector.status).toBe("FAILED");
    const failed = res.body.data.result.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);
    expect(failed).toEqual(["cors", "cors-etag"]);
    expect((await uploadPdf(staff)).status).toBe(409);
  });

  it("fails verification when storage is unreachable", async () => {
    await api(sa).put(url(), accessKeyConnector);
    h.connectorStorage.failNext("checkConnectivity", "ACCESS_DENIED");
    const res = await api(sa).post(`${url()}/verify`);
    expect(res.body.data.result.checks).toEqual([expect.objectContaining({ id: "access", ok: false })]);
    expect(res.body.data.connector.status).toBe("FAILED");
  });

  it("stores new uploads in the customer's bucket and downloads them from there", async () => {
    await connectAndVerify();
    const init = await uploadPdf(staff);
    expect(init.status).toBe(201);
    expect(init.body.data.upload.url).toContain("customer-bucket.invalid");
    const doc = await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } });
    expect(doc.storageConnectorId).not.toBeNull();
    h.connectorStorage.putObject(doc.objectKey, PDF);
    expect((await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(200);
    expect(h.storage.objects.has(doc.objectKey)).toBe(false);

    await prisma().customerUserFolderPermission.create({
      data: { userId: seed.users.antrixUser.id, customerId: seed.customers.antrix.id, folderId: seed.folders.contracts.id, permission: "DOWNLOAD" },
    });
    const user = await login(h.app, "user@antrix.test");
    const dl = await api(user).get(`/api/v1/documents/${doc.id}/download`);
    expect(dl.body.data.url).toContain("customer-bucket.invalid");
    // Documents uploaded before the connector existed are still served from platform storage.
    const old = await api(user).get(`/api/v1/documents/${seed.docs.contract.id}/download`);
    expect(old.body.data.url).toContain("memory-storage.invalid");
  });

  it("protects stored documents: location changes and deletion are refused while documents use the connector", async () => {
    await connectAndVerify();
    const init = await uploadPdf(staff);
    h.connectorStorage.putObject((await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } })).objectKey, PDF);
    await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);

    const move = await api(sa).put(url(), { ...accessKeyConnector, bucket: "another-bucket" });
    expect(move.status).toBe(409);
    expect(move.body.error.details.changed).toEqual(["bucket"]);
    expect((await api(sa).delete(url())).status).toBe(409);

    // Credential rotation is allowed, keeps the stored secret when omitted, and requires re-verification.
    const rotate = await api(sa).put(url(), { ...accessKeyConnector, secretAccessKey: undefined });
    expect(rotate.status).toBe(200);
    expect(rotate.body.data.status).toBe("PENDING_VERIFICATION");
    expect((await uploadPdf(staff, "Second.pdf")).status).toBe(409);
    expect((await api(sa).post(`${url()}/verify`)).body.data.connector.status).toBe("ACTIVE");
  });

  it("disabling blocks new uploads but keeps existing documents downloadable; re-enabling needs verification", async () => {
    await connectAndVerify();
    const init = await uploadPdf(staff);
    const doc = await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } });
    h.connectorStorage.putObject(doc.objectKey, PDF);
    await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);

    expect((await api(sa).post(`${url()}/disable`)).body.data.status).toBe("DISABLED");
    expect((await uploadPdf(staff, "Blocked.pdf")).status).toBe(409);
    expect((await api(staff).get(`/api/v1/documents/${doc.id}/download`)).status).toBe(200);
    expect((await api(sa).post(`${url()}/verify`)).body.data.connector.status).toBe("DISABLED");
    expect((await api(sa).post(`${url()}/enable`)).body.data.status).toBe("PENDING_VERIFICATION");
  });

  it("keeps the stored access key when an edit omits the key id and secret", async () => {
    await api(sa).put(url(), accessKeyConnector);
    const before = await prisma().storageConnector.findFirstOrThrow();
    const res = await api(sa).put(url(), { ...accessKeyConnector, accessKeyId: undefined, secretAccessKey: undefined });
    expect(res.status).toBe(200);
    const after = await prisma().storageConnector.findFirstOrThrow();
    expect(after.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(after.secretCiphertext).toBe(before.secretCiphertext);
    // A new key id without a secret is refused.
    expect((await api(sa).put(url(), { ...accessKeyConnector, accessKeyId: "AKIANEWKEY000000EXAM", secretAccessKey: undefined })).status).toBe(400);
  });

  it("deletes an unused connector", async () => {
    await api(sa).put(url(), accessKeyConnector);
    expect((await api(sa).delete(url())).status).toBe(204);
    expect(await prisma().storageConnector.count()).toBe(0);
  });

  it("purges deleted documents from the customer's bucket", async () => {
    await connectAndVerify();
    const init = await uploadPdf(staff);
    const doc = await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } });
    h.connectorStorage.putObject(doc.objectKey, PDF);
    await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    await api(staff).delete(`/api/v1/documents/${doc.id}`);
    await prisma().document.update({ where: { id: doc.id }, data: { purgeAfter: new Date(Date.now() - 1000) } });
    expect(await purgeDeletedDocuments(h.services)).toEqual({ purged: 1, failed: 0 });
    expect(h.connectorStorage.objects.has(doc.objectKey)).toBe(false);
  });

  it("reconciliation scans the customer's bucket, flags missing and misplaced objects", async () => {
    await connectAndVerify();
    const init = await uploadPdf(staff);
    const doc = await prisma().document.findUniqueOrThrow({ where: { id: init.body.data.documentId } });
    h.connectorStorage.putObject(doc.objectKey, PDF);
    await api(staff).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    // A copy of a platform document turns up in the customer bucket (e.g. a manual migration).
    h.connectorStorage.putObject(seed.docs.report.objectKey, "copy");
    // The connector document's own object disappears.
    h.connectorStorage.objects.delete(doc.objectKey);

    const report = await reconcileStorage(h.services, { fix: true });
    expect(report.targets).toEqual(["platform", "connector:antrix-documents"]);
    expect(report.misplacedObjects).toEqual([`connector:antrix-documents:${seed.docs.report.objectKey}`]);
    expect(report.missingObjects).toEqual([doc.id]);
    expect(report.markedMissing).toBe(1);
    // Misplaced objects are never deleted automatically.
    expect(h.connectorStorage.objects.has(seed.docs.report.objectKey)).toBe(true);
  });

  it("reports an unreachable customer bucket instead of failing the whole reconciliation", async () => {
    await connectAndVerify();
    h.connectorStorage.failNext("listObjects", "ACCESS_DENIED");
    const report = await reconcileStorage(h.services, { fix: false });
    expect(report.unreachableTargets).toEqual([expect.objectContaining({ target: "connector:antrix-documents" })]);
  });

  it("adds the customer bucket origin to the page CSP so browsers may upload to it", async () => {
    await api(sa).put(url(), accessKeyConnector);
    const res = await request(h.app).get("/some-page");
    expect(res.headers["content-security-policy"]).toContain("https://antrix-documents.s3.ap-south-1.amazonaws.com");
  });

  describe("access control and validation", () => {
    it("only the Super Admin can manage connectors; assigned staff get a summary without secrets", async () => {
      await api(sa).put(url(), accessKeyConnector);
      const summary = await api(staff).get(url());
      expect(summary.status).toBe(200);
      expect(summary.body.data.connector).toEqual({ provider: "AWS_S3", bucket: "antrix-documents", region: "ap-south-1", status: "PENDING_VERIFICATION" });
      expect((await api(staff).put(url(), accessKeyConnector)).status).toBe(403);
      expect((await api(staff).post(`${url()}/verify`)).status).toBe(403);
      expect((await api(staff).delete(url())).status).toBe(403);
      const other = await login(h.app, "staff2@tekpro.test");
      expect((await api(other).get(url())).status).toBe(404);
      const admin = await login(h.app, "admin@antrix.test");
      expect((await api(admin).get(url())).status).toBe(403);
    });

    it("validates provider, auth and endpoint combinations", async () => {
      const bad = [
        { ...accessKeyConnector, bucket: "Bad_Bucket" },
        { ...accessKeyConnector, region: "mars" },
        { provider: "LIGHTSAIL", bucket: "b-1", region: "ap-south-1", authType: "ASSUME_ROLE", roleArn: "arn:aws:iam::123456789012:role/x" },
        { provider: "AWS_S3", bucket: "b-1", region: "ap-south-1", authType: "ASSUME_ROLE", roleArn: "not-an-arn" },
        { ...accessKeyConnector, endpoint: "https://s3.example.com" },
        { ...accessKeyConnector, provider: "S3_COMPATIBLE" },
      ];
      for (const body of bad) expect((await api(sa).put(url(), body)).status, JSON.stringify(body)).toBe(400);
    });

    it.each(["http://storage.example.com", "https://169.254.169.254", "https://10.0.0.5", "https://localhost:9000", "https://user:pw@s3.example.com", "https://[::1]"])(
      "rejects unsafe custom endpoint %s (SSRF protection)",
      async (endpoint) => {
        const res = await api(sa).put(url(), { ...accessKeyConnector, provider: "S3_COMPATIBLE", endpoint, forcePathStyle: true });
        expect(res.status).toBe(400);
      },
    );

    it("refuses access-key connectors when no encryption key is configured", async () => {
      const noKey = createTestApp({ CONNECTOR_ENCRYPTION_KEY: "" });
      const admin = await login(noKey.app, "super@tekpro.test");
      const res = await api(admin).put(url(), accessKeyConnector);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/CONNECTOR_ENCRYPTION_KEY/);
    });

    it("accepts a cross-account role connector and shows the External ID for the trust policy", async () => {
      const res = await api(sa).put(url(), {
        provider: "AWS_S3",
        bucket: "antrix-documents",
        region: "ap-south-1",
        authType: "ASSUME_ROLE",
        roleArn: "arn:aws:iam::123456789012:role/TekproPortalAccess",
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ authType: "ASSUME_ROLE", roleArn: "arn:aws:iam::123456789012:role/TekproPortalAccess", accessKeyIdMasked: null });
      expect(res.body.data.externalId).toMatch(/^tekpro-[A-Za-z0-9_-]{20,}$/);
    });
  });
});
