import { beforeAll, describe, expect, it } from "vitest";
import { api, createTestApp, login, prisma, resetDb, seedTwoTenants, type LoggedIn, type Seed, type TestHarness } from "../helpers/testApp.js";

/**
 * Cross-tenant isolation: every attempt to reach another customer's data by
 * changing customer ids, folder ids, document ids, request bodies or query
 * parameters must be denied, and search must not leak metadata.
 */
describe("cross-tenant isolation", () => {
  let h: TestHarness;
  let seed: Seed;
  let antrixAdmin: LoggedIn;
  let antrixUser: LoggedIn;
  let staff: LoggedIn;
  let betaAdmin: LoggedIn;

  beforeAll(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
    antrixAdmin = await login(h.app, "admin@antrix.test");
    antrixUser = await login(h.app, "user@antrix.test");
    staff = await login(h.app, "staff@tekpro.test");
    betaAdmin = await login(h.app, "admin@beta.test");
  });

  const betaId = () => seed.customers.beta.id;

  it("customer users only see their own customer in the customer list", async () => {
    const res = await api(antrixAdmin).get("/api/v1/customers");
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((c: { name: string }) => c.name)).toEqual(["Antrix"]);
  });

  it("Tekpro users only see assigned customers", async () => {
    const res = await api(staff).get("/api/v1/customers");
    expect(res.body.data.items.map((c: { name: string }) => c.name)).toEqual(["Antrix"]);
  });

  it.each([
    ["customer details", (id: string) => `/api/v1/customers/${id}`],
    ["folder list", (id: string) => `/api/v1/customers/${id}/folders`],
    ["document list", (id: string) => `/api/v1/customers/${id}/documents`],
    ["document search", (id: string) => `/api/v1/customers/${id}/documents?q=Secret`],
  ])("changing the customer id in the URL is denied (%s)", async (_name, url) => {
    for (const who of [antrixAdmin, antrixUser, staff]) {
      const res = await api(who).get(url(betaId()));
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Beta Secret Pricing");
    }
  });

  it("changing a document id to another customer's document is denied for metadata and download", async () => {
    const betaDoc = seed.docs.beta.id;
    for (const who of [antrixAdmin, antrixUser, staff]) {
      expect((await api(who).get(`/api/v1/documents/${betaDoc}`)).status).toBe(404);
      const dl = await api(who).get(`/api/v1/documents/${betaDoc}/download`);
      expect(dl.status).toBe(404);
      expect(dl.body.data).toBeUndefined();
    }
  });

  it("changing a folder id to another customer's folder is denied", async () => {
    const betaFolder = seed.folders.betaDocs.id;
    for (const who of [antrixAdmin, antrixUser, staff]) {
      expect((await api(who).get(`/api/v1/folders/${betaFolder}`)).status).toBe(404);
    }
    const viaQuery = await api(antrixAdmin).get(`/api/v1/customers/${seed.customers.antrix.id}/documents?folderId=${betaFolder}`);
    expect(viaQuery.status).toBe(404);
  });

  it("a Tekpro user cannot upload into an unassigned customer, even naming an assigned folder", async () => {
    const res = await api(staff).post(`/api/v1/customers/${betaId()}/uploads/initiate`, {
      folderId: seed.folders.betaDocs.id,
      filename: "x.pdf",
      sizeBytes: 10,
    });
    expect(res.status).toBe(404);
    const mixed = await api(staff).post(`/api/v1/customers/${seed.customers.antrix.id}/uploads/initiate`, {
      folderId: seed.folders.betaDocs.id,
      filename: "x.pdf",
      sizeBytes: 10,
    });
    expect(mixed.status).toBe(404);
    expect(await prisma().document.count({ where: { customerId: seed.customers.beta.id } })).toBe(1);
  });

  it("a Tekpro user cannot move a document into another customer's folder via the request body", async () => {
    const res = await api(staff).patch(`/api/v1/documents/${seed.docs.contract.id}`, { folderId: seed.folders.betaDocs.id });
    expect(res.status).toBe(404);
    const doc = await prisma().document.findUniqueOrThrow({ where: { id: seed.docs.contract.id } });
    expect(doc.folderId).toBe(seed.folders.contracts.id);
  });

  it("a Super Admin cannot move documents or folders across customers either", async () => {
    const sa = await login(h.app, "super@tekpro.test");
    const doc = await api(sa).patch(`/api/v1/documents/${seed.docs.contract.id}`, { folderId: seed.folders.betaDocs.id });
    expect(doc.status).toBe(400);
    const folder = await api(sa).patch(`/api/v1/folders/${seed.folders.contracts.id}`, { parentFolderId: seed.folders.betaDocs.id });
    expect(folder.status).toBe(400);
  });

  it("a Tekpro user cannot create a folder in an unassigned customer or under its folders", async () => {
    expect((await api(staff).post(`/api/v1/customers/${betaId()}/folders`, { name: "x" })).status).toBe(404);
    const viaParent = await api(staff).post(`/api/v1/customers/${seed.customers.antrix.id}/folders`, {
      name: "x",
      parentFolderId: seed.folders.betaDocs.id,
    });
    expect(viaParent.status).toBe(404);
  });

  it("database constraints reject a folder whose parent belongs to another customer", async () => {
    await expect(
      prisma().folder.create({
        data: { customerId: seed.customers.antrix.id, parentFolderId: seed.folders.betaDocs.id, name: "smuggled" },
      }),
    ).rejects.toThrow();
  });

  it("database constraints reject a document stored in another customer's folder", async () => {
    const id = crypto.randomUUID();
    await expect(
      prisma().document.create({
        data: {
          id,
          customerId: seed.customers.antrix.id,
          folderId: seed.folders.betaDocs.id,
          displayName: "x.pdf",
          objectKey: `customers/${seed.customers.antrix.id}/documents/${id}`,
          mimeType: "application/pdf",
          sizeBytes: 1n,
        },
      }),
    ).rejects.toThrow();
  });

  it("database constraints reject a folder grant that crosses customers", async () => {
    await expect(
      prisma().customerUserFolderPermission.create({
        data: { userId: seed.users.antrixUser.id, customerId: seed.customers.beta.id, folderId: seed.folders.betaDocs.id, permission: "DOWNLOAD" },
      }),
    ).rejects.toThrow();
  });

  it("search across the whole customer never returns documents from inaccessible folders", async () => {
    const res = await api(antrixUser).get(`/api/v1/customers/${seed.customers.antrix.id}/documents?q=PDF&pageSize=100`);
    expect(res.status).toBe(200);
    const names = res.body.data.items.map((d: { displayName: string }) => d.displayName).sort();
    expect(names).toEqual(["Annual Report.pdf", "Q1 Summary.pdf"]);
    expect(res.body.data.pagination.total).toBe(2);
  });

  it("customer roles cannot list non-available documents by tampering with the status query", async () => {
    await prisma().document.update({ where: { id: seed.docs.report.id }, data: { status: "DELETED", deletedAt: new Date() } });
    const res = await api(antrixAdmin).get(`/api/v1/customers/${seed.customers.antrix.id}/documents?status=DELETED`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((d: { status: string }) => d.status)).not.toContain("DELETED");
    expect((await api(antrixAdmin).get(`/api/v1/documents/${seed.docs.report.id}`)).status).toBe(404);
    await prisma().document.update({ where: { id: seed.docs.report.id }, data: { status: "AVAILABLE", deletedAt: null } });
  });

  it("the Beta admin cannot see Antrix data", async () => {
    expect((await api(betaAdmin).get(`/api/v1/documents/${seed.docs.report.id}/download`)).status).toBe(404);
    expect((await api(betaAdmin).get(`/api/v1/customers/${seed.customers.antrix.id}/documents`)).status).toBe(404);
  });

  it("denied attempts are recorded as security audit events", async () => {
    const denials = await prisma().auditLog.count({ where: { action: "security.access_denied", outcome: "DENIED" } });
    expect(denials).toBeGreaterThan(5);
  });

  it("responses never expose storage object keys", async () => {
    const list = await api(staff).get(`/api/v1/customers/${seed.customers.antrix.id}/documents`);
    expect(JSON.stringify(list.body)).not.toContain("customers/");
    const one = await api(staff).get(`/api/v1/documents/${seed.docs.report.id}`);
    expect(one.body.data.objectKey).toBeUndefined();
  });
});
