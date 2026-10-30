import { beforeEach, describe, expect, it } from "vitest";
import { api, createTestApp, login, prisma, resetDb, seedTwoTenants, type LoggedIn, type Seed, type TestHarness } from "../helpers/testApp.js";

describe("role enforcement", () => {
  let h: TestHarness;
  let seed: Seed;

  beforeEach(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
  });

  describe("Designated Tekpro User", () => {
    let staff: LoggedIn;
    beforeEach(async () => {
      staff = await login(h.app, "staff@tekpro.test");
    });

    it("can browse, download and manage an assigned customer", async () => {
      const antrix = seed.customers.antrix.id;
      expect((await api(staff).get(`/api/v1/customers/${antrix}/folders`)).body.data).toHaveLength(5);
      expect((await api(staff).get(`/api/v1/documents/${seed.docs.internal.id}/download`)).status).toBe(200);
      const folder = await api(staff).post(`/api/v1/customers/${antrix}/folders`, { name: "Invoices" });
      expect(folder.status).toBe(201);
      expect((await api(staff).patch(`/api/v1/documents/${seed.docs.contract.id}`, { displayName: "Renamed Contract.pdf" })).status).toBe(200);
      expect((await api(staff).patch(`/api/v1/documents/${seed.docs.contract.id}`, { folderId: folder.body.data.id })).status).toBe(200);
      expect((await api(staff).delete(`/api/v1/documents/${seed.docs.contract.id}`)).status).toBe(200);
    });

    it("cannot create customers, manage users, assign customers or change settings", async () => {
      expect((await api(staff).post("/api/v1/customers", { name: "New", customerCode: "NEW" })).status).toBe(403);
      expect((await api(staff).get("/api/v1/users")).status).toBe(403);
      expect((await api(staff).post("/api/v1/users", { email: "x@y.test", fullName: "X", role: "TEKPRO_USER" })).status).toBe(403);
      expect((await api(staff).patch(`/api/v1/users/${staff.userId}`, { role: "SUPER_ADMIN" })).status).toBe(403);
      expect(
        (await api(staff).post(`/api/v1/customers/${seed.customers.beta.id}/assignments`, { userId: staff.userId })).status,
      ).toBe(403);
      expect((await api(staff).patch("/api/v1/settings", { staffAuditAccess: true })).status).toBe(403);
      expect((await api(staff).get("/api/v1/stats/overview")).status).toBe(403);
      expect(
        (await api(staff).put(`/api/v1/users/${seed.users.antrixUser.id}/folder-permissions/${seed.folders.contracts.id}`, { permission: "DOWNLOAD" })).status,
      ).toBe(403);
      expect((await api(staff).patch(`/api/v1/folders/${seed.folders.hidden.id}`, { hiddenFromCustomer: false })).status).toBe(403);
      const me = await prisma().user.findUniqueOrThrow({ where: { id: staff.userId } });
      expect(me.role).toBe("TEKPRO_USER");
    });

    it("sees only audit records of assigned customers", async () => {
      await api(staff).get(`/api/v1/documents/${seed.docs.report.id}/download`);
      const other = await login(h.app, "staff2@tekpro.test");
      await api(other).get(`/api/v1/documents/${seed.docs.beta.id}/download`);
      const res = await api(staff).get("/api/v1/audit-logs?pageSize=100");
      expect(res.status).toBe(200);
      const customers = new Set(res.body.data.items.map((a: { customer: { id: string } | null }) => a.customer?.id));
      expect(customers).toEqual(new Set([seed.customers.antrix.id]));
    });

    it("loses access immediately when the assignment is removed", async () => {
      expect((await api(staff).get(`/api/v1/customers/${seed.customers.antrix.id}/documents`)).status).toBe(200);
      const sa = await login(h.app, "super@tekpro.test");
      expect((await api(sa).delete(`/api/v1/customers/${seed.customers.antrix.id}/assignments/${staff.userId}`)).status).toBe(204);
      expect((await api(staff).get(`/api/v1/customers/${seed.customers.antrix.id}/documents`)).status).toBe(404);
      expect((await api(staff).get(`/api/v1/documents/${seed.docs.report.id}/download`)).status).toBe(404);
      expect((await api(staff).get("/api/v1/customers")).body.data.items).toHaveLength(0);
    });

    it("cannot delete documents when the Super Admin disables staff deletion", async () => {
      const sa = await login(h.app, "super@tekpro.test");
      await api(sa).patch("/api/v1/settings", { staffCanDeleteDocuments: false });
      expect((await api(staff).delete(`/api/v1/documents/${seed.docs.contract.id}`)).status).toBe(403);
    });

    it("cannot see audit records when staff audit access is disabled", async () => {
      const sa = await login(h.app, "super@tekpro.test");
      await api(sa).patch("/api/v1/settings", { staffAuditAccess: false });
      expect((await api(staff).get("/api/v1/audit-logs")).status).toBe(403);
    });
  });

  describe("Antrix Admin (customer admin)", () => {
    let admin: LoggedIn;
    beforeEach(async () => {
      admin = await login(h.app, "admin@antrix.test");
    });

    it("can browse all non-hidden folders and download documents", async () => {
      const folders = await api(admin).get(`/api/v1/customers/${seed.customers.antrix.id}/folders`);
      const names = folders.body.data.map((f: { name: string }) => f.name).sort();
      expect(names).toEqual(["2024", "Confidential", "Contracts", "Reports"]);
      expect(folders.body.data[0]).not.toHaveProperty("hiddenFromCustomer");
      const dl = await api(admin).get(`/api/v1/documents/${seed.docs.secret.id}/download`);
      expect(dl.status).toBe(200);
      expect(dl.body.data.url).toMatch(/^https:\/\//);
    });

    it("cannot see or download documents in folders hidden from the customer", async () => {
      expect((await api(admin).get(`/api/v1/documents/${seed.docs.internal.id}/download`)).status).toBe(404);
      expect((await api(admin).get(`/api/v1/folders/${seed.folders.hidden.id}`)).status).toBe(404);
    });

    it("cannot upload, rename, move or delete documents or folders", async () => {
      const antrix = seed.customers.antrix.id;
      expect(
        (await api(admin).post(`/api/v1/customers/${antrix}/uploads/initiate`, { folderId: seed.folders.reports.id, filename: "a.pdf", sizeBytes: 5 })).status,
      ).toBe(403);
      expect((await api(admin).post(`/api/v1/customers/${antrix}/folders`, { name: "Mine" })).status).toBe(403);
      expect((await api(admin).patch(`/api/v1/documents/${seed.docs.report.id}`, { displayName: "x.pdf" })).status).toBe(403);
      expect((await api(admin).patch(`/api/v1/documents/${seed.docs.report.id}`, { folderId: seed.folders.contracts.id })).status).toBe(403);
      expect((await api(admin).delete(`/api/v1/documents/${seed.docs.report.id}`)).status).toBe(403);
      expect((await api(admin).patch(`/api/v1/folders/${seed.folders.reports.id}`, { name: "Renamed" })).status).toBe(403);
      expect((await api(admin).delete(`/api/v1/folders/${seed.folders.contracts.id}`)).status).toBe(403);
      const doc = await prisma().document.findUniqueOrThrow({ where: { id: seed.docs.report.id } });
      expect(doc.displayName).toBe("Annual Report.pdf");
      expect(doc.status).toBe("AVAILABLE");
    });

    it("cannot create users or change permissions", async () => {
      expect(
        (await api(admin).post("/api/v1/users", { email: "n@antrix.test", fullName: "N", role: "CUSTOMER_USER", customerId: seed.customers.antrix.id })).status,
      ).toBe(403);
      expect(
        (await api(admin).put(`/api/v1/users/${seed.users.antrixUser.id}/folder-permissions/${seed.folders.confidential.id}`, { permission: "DOWNLOAD" })).status,
      ).toBe(403);
      expect((await api(admin).patch(`/api/v1/customers/${seed.customers.antrix.id}`, { name: "Hacked" })).status).toBe(403);
      expect((await api(admin).get(`/api/v1/customers/${seed.customers.antrix.id}/assignments`)).status).toBe(403);
    });

    it("can view organisation activity when enabled, limited to customer-visible actions", async () => {
      const user = await login(h.app, "user@antrix.test");
      await api(user).get(`/api/v1/documents/${seed.docs.report.id}/download`);
      const staff = await login(h.app, "staff@tekpro.test");
      await api(staff).get(`/api/v1/documents/${seed.docs.report.id}/download`);
      const res = await api(admin).get("/api/v1/audit-logs?pageSize=100");
      expect(res.status).toBe(200);
      const actions = new Set(res.body.data.items.map((a: { action: string }) => a.action));
      for (const a of actions) expect(["document.download.link_issued", "auth.login.succeeded", "auth.logout"]).toContain(a);
      // Tekpro staff activity is not shown to the customer.
      const actors = res.body.data.items.map((a: { actor: { id: string } }) => a.actor?.id);
      expect(actors).not.toContain(staff.userId);
      expect(res.body.data.items[0]).not.toHaveProperty("ipAddress");
    });
  });

  describe("Antrix Customer User", () => {
    let user: LoggedIn;
    beforeEach(async () => {
      user = await login(h.app, "user@antrix.test");
    });

    it("downloads documents from assigned folders, including inherited subfolders", async () => {
      expect((await api(user).get(`/api/v1/documents/${seed.docs.report.id}/download`)).status).toBe(200);
      expect((await api(user).get(`/api/v1/documents/${seed.docs.report2024.id}/download`)).status).toBe(200);
    });

    it("cannot download from unassigned folders or explicitly denied subfolders", async () => {
      expect((await api(user).get(`/api/v1/documents/${seed.docs.contract.id}/download`)).status).toBe(404);
      expect((await api(user).get(`/api/v1/documents/${seed.docs.secret.id}/download`)).status).toBe(404);
      expect((await api(user).get(`/api/v1/folders/${seed.folders.contracts.id}`)).status).toBe(404);
    });

    it("sees only permitted folders", async () => {
      const res = await api(user).get(`/api/v1/customers/${seed.customers.antrix.id}/folders`);
      expect(res.body.data.map((f: { name: string }) => f.name).sort()).toEqual(["2024", "Reports"]);
    });

    it("with VIEW permission can see metadata but not download", async () => {
      const sa = await login(h.app, "super@tekpro.test");
      await api(sa).put(`/api/v1/users/${user.userId}/folder-permissions/${seed.folders.contracts.id}`, { permission: "VIEW" });
      expect((await api(user).get(`/api/v1/documents/${seed.docs.contract.id}`)).status).toBe(200);
      const dl = await api(user).get(`/api/v1/documents/${seed.docs.contract.id}/download`);
      expect(dl.status).toBe(403);
    });

    it("loses access as soon as a permission is removed", async () => {
      const sa = await login(h.app, "super@tekpro.test");
      await api(sa).delete(`/api/v1/users/${user.userId}/folder-permissions/${seed.folders.reports.id}`);
      expect((await api(user).get(`/api/v1/documents/${seed.docs.report.id}/download`)).status).toBe(404);
    });

    it("cannot upload, modify documents, create folders, or change its own role or permissions", async () => {
      const antrix = seed.customers.antrix.id;
      expect(
        (await api(user).post(`/api/v1/customers/${antrix}/uploads/initiate`, { folderId: seed.folders.reports.id, filename: "a.pdf", sizeBytes: 5 })).status,
      ).toBe(403);
      expect((await api(user).patch(`/api/v1/documents/${seed.docs.report.id}`, { displayName: "x.pdf" })).status).toBe(403);
      expect((await api(user).delete(`/api/v1/documents/${seed.docs.report.id}`)).status).toBe(403);
      expect((await api(user).post(`/api/v1/customers/${antrix}/folders`, { name: "Mine" })).status).toBe(403);
      expect((await api(user).patch(`/api/v1/users/${user.userId}`, { role: "CUSTOMER_ADMIN" })).status).toBe(403);
      expect(
        (await api(user).put(`/api/v1/users/${user.userId}/folder-permissions/${seed.folders.contracts.id}`, { permission: "DOWNLOAD" })).status,
      ).toBe(403);
      expect((await api(user).post("/api/v1/users", { email: "z@antrix.test", fullName: "Z", role: "CUSTOMER_USER", customerId: antrix })).status).toBe(403);
    });

    it("cannot view activity unless enabled", async () => {
      expect((await api(user).get("/api/v1/audit-logs")).status).toBe(403);
    });

    it("cannot call upload completion or abort for someone else's upload", async () => {
      const staff = await login(h.app, "staff@tekpro.test");
      const init = await api(staff).post(`/api/v1/customers/${seed.customers.antrix.id}/uploads/initiate`, {
        folderId: seed.folders.reports.id,
        filename: "x.pdf",
        sizeBytes: 5,
      });
      expect(init.status).toBe(201);
      expect((await api(user).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`)).status).toBe(404);
      expect((await api(user).post(`/api/v1/uploads/${init.body.data.uploadId}/abort`)).status).toBe(404);
    });
  });

  it("a deactivated customer immediately blocks its users", async () => {
    const user = await login(h.app, "user@antrix.test");
    const sa = await login(h.app, "super@tekpro.test");
    expect((await api(sa).patch(`/api/v1/customers/${seed.customers.antrix.id}`, { status: "INACTIVE" })).status).toBe(200);
    expect((await api(user).get("/api/v1/auth/me")).status).toBe(401);
    const staff = await login(h.app, "staff@tekpro.test");
    expect((await api(staff).get(`/api/v1/documents/${seed.docs.report.id}/download`)).status).toBe(404);
  });
});
