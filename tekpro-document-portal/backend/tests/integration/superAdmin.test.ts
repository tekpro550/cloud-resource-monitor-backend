import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createTestApp, login, PASSWORD, prisma, resetDb, seedTwoTenants, type LoggedIn, type Seed, type TestHarness } from "../helpers/testApp.js";

describe("Super Admin administration", () => {
  let h: TestHarness;
  let seed: Seed;
  let sa: LoggedIn;

  beforeEach(async () => {
    await resetDb();
    h = createTestApp();
    seed = await seedTwoTenants(h.storage);
    sa = await login(h.app, "super@tekpro.test");
  });

  describe("customers", () => {
    it("creates, lists, searches, updates and deactivates customers", async () => {
      const created = await api(sa).post("/api/v1/customers", { name: "Gamma Ltd", customerCode: "gamma" });
      expect(created.status).toBe(201);
      expect(created.body.data.customerCode).toBe("GAMMA");
      expect((await api(sa).post("/api/v1/customers", { name: "Dup", customerCode: "GAMMA" })).status).toBe(409);
      expect((await api(sa).post("/api/v1/customers", { name: "Bad", customerCode: "x y" })).status).toBe(400);

      const all = await api(sa).get("/api/v1/customers");
      expect(all.body.data.items.map((c: { name: string }) => c.name)).toEqual(["Antrix", "Beta Corp", "Gamma Ltd"]);
      expect(all.body.data.items[0].documentCount).toBe(5);
      const search = await api(sa).get("/api/v1/customers?q=gam");
      expect(search.body.data.items).toHaveLength(1);

      const upd = await api(sa).patch(`/api/v1/customers/${created.body.data.id}`, { name: "Gamma Limited", status: "INACTIVE" });
      expect(upd.body.data).toMatchObject({ name: "Gamma Limited", status: "INACTIVE" });
      const actions = (await prisma().auditLog.findMany({ where: { customerId: created.body.data.id } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["customer.created", "customer.deactivated", "customer.updated"]));
    });

    it("returns customer statistics", async () => {
      const res = await api(sa).get(`/api/v1/customers/${seed.customers.antrix.id}/stats`);
      expect(res.body.data.documentsByStatus.AVAILABLE.count).toBe(5);
      expect(res.body.data.folders).toBe(5);
      expect(res.body.data.activeUsers).toBe(2);
    });
  });

  describe("assignments", () => {
    it("assigns and unassigns Tekpro users, rejecting duplicates and non-staff", async () => {
      const url = `/api/v1/customers/${seed.customers.beta.id}/assignments`;
      expect((await api(sa).post(url, { userId: seed.users.staff.id })).status).toBe(201);
      expect((await api(sa).post(url, { userId: seed.users.staff.id })).status).toBe(409);
      expect((await api(sa).post(url, { userId: seed.users.antrixAdmin.id })).status).toBe(400);
      const listed = await api(sa).get(url);
      expect(listed.body.data.map((a: { user: { email: string } }) => a.user.email).sort()).toEqual(["staff2@tekpro.test", "staff@tekpro.test"]);

      // The assignment takes effect immediately for an existing session.
      const staff = await login(h.app, "staff@tekpro.test");
      expect((await api(staff).get(`/api/v1/customers/${seed.customers.beta.id}/documents`)).status).toBe(200);
      expect((await api(sa).delete(`${url}/${seed.users.staff.id}`)).status).toBe(204);
      expect((await api(staff).get(`/api/v1/customers/${seed.customers.beta.id}/documents`)).status).toBe(404);
    });
  });

  describe("users", () => {
    it("creates users with an invitation link that sets the password", async () => {
      const res = await api(sa).post("/api/v1/users", {
        email: "New.User@Antrix.test",
        fullName: "New User",
        role: "CUSTOMER_USER",
        customerId: seed.customers.antrix.id,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ email: "new.user@antrix.test", passwordSet: false, role: "CUSTOMER_USER" });
      expect(res.body.data.invite.emailSent).toBe(true);
      expect(res.body.data.invite.link).toBeUndefined();
      const token = /token=([A-Za-z0-9_-]+)/.exec(h.mailer.sent.at(-1)!.text)![1]!;

      expect((await request(h.app).post("/api/v1/auth/login").send({ email: "new.user@antrix.test", password: "anything" })).status).toBe(401);
      expect((await request(h.app).post("/api/v1/auth/reset-password").send({ token, newPassword: "Welcome-Aboard-2024" })).status).toBe(200);
      await login(h.app, "new.user@antrix.test", "Welcome-Aboard-2024");
    });

    it("returns invitation links to the Super Admin only when explicitly enabled", async () => {
      const withLinks = createTestApp({ ALLOW_ADMIN_RESET_LINKS: "true" });
      const admin = await login(withLinks.app, "super@tekpro.test");
      const res = await api(admin).post("/api/v1/users", { email: "linked@tekpro.test", fullName: "Linked", role: "TEKPRO_USER" });
      expect(res.body.data.invite.link).toMatch(/^http:\/\/portal\.test\/reset-password\?token=/);
    });

    it("enforces role/customer relationships and unique emails", async () => {
      expect((await api(sa).post("/api/v1/users", { email: "a@x.test", fullName: "A", role: "CUSTOMER_USER" })).status).toBe(400);
      expect(
        (await api(sa).post("/api/v1/users", { email: "b@x.test", fullName: "B", role: "TEKPRO_USER", customerId: seed.customers.antrix.id })).status,
      ).toBe(400);
      expect((await api(sa).post("/api/v1/users", { email: "STAFF@tekpro.test", fullName: "Dup", role: "TEKPRO_USER" })).status).toBe(409);
      await expect(
        prisma().user.create({ data: { email: "c@x.test", fullName: "C", role: "CUSTOMER_ADMIN" } }),
      ).rejects.toThrow();
    });

    it("lists and filters users without exposing password hashes", async () => {
      const res = await api(sa).get(`/api/v1/users?customerId=${seed.customers.antrix.id}`);
      expect(res.body.data.items.map((u: { email: string }) => u.email).sort()).toEqual(["admin@antrix.test", "user@antrix.test"]);
      expect(JSON.stringify(res.body)).not.toContain("argon2");
      const staffOnly = await api(sa).get("/api/v1/users?scope=staff");
      expect(staffOnly.body.data.items.every((u: { role: string }) => ["SUPER_ADMIN", "TEKPRO_USER"].includes(u.role))).toBe(true);
    });

    it("changes roles within a category, revoking sessions; refuses cross-category and self changes", async () => {
      const userSession = await login(h.app, "user@antrix.test");
      const res = await api(sa).patch(`/api/v1/users/${seed.users.antrixUser.id}`, { role: "CUSTOMER_ADMIN" });
      expect(res.status).toBe(200);
      expect((await userSession.agent.get("/api/v1/auth/me")).status).toBe(401);
      expect(await prisma().customerUserFolderPermission.count({ where: { userId: seed.users.antrixUser.id } })).toBe(0);
      expect((await api(sa).patch(`/api/v1/users/${seed.users.antrixAdmin.id}`, { role: "TEKPRO_USER" })).status).toBe(400);
      expect((await api(sa).patch(`/api/v1/users/${sa.userId}`, { role: "TEKPRO_USER" })).status).toBe(400);
      expect(await prisma().auditLog.count({ where: { action: "user.role_changed" } })).toBe(1);
    });

    it("deactivates and reactivates users; cannot deactivate itself or the last Super Admin", async () => {
      const staffSession = await login(h.app, "staff@tekpro.test");
      expect((await api(sa).post(`/api/v1/users/${seed.users.staff.id}/deactivate`)).status).toBe(200);
      expect((await staffSession.agent.get("/api/v1/auth/me")).status).toBe(401);
      expect((await request(h.app).post("/api/v1/auth/login").send({ email: "staff@tekpro.test", password: PASSWORD })).status).toBe(401);
      expect((await api(sa).post(`/api/v1/users/${seed.users.staff.id}/activate`)).status).toBe(200);
      await login(h.app, "staff@tekpro.test");
      expect((await api(sa).post(`/api/v1/users/${sa.userId}/deactivate`)).status).toBe(400);
    });

    it("triggers a password reset email", async () => {
      const res = await api(sa).post(`/api/v1/users/${seed.users.staff.id}/password-reset`);
      expect(res.status).toBe(200);
      expect(res.body.data.emailSent).toBe(true);
      expect(h.mailer.sent.at(-1)!.to).toBe("staff@tekpro.test");
    });

    it("grants, changes and removes customer folder permissions with auditing", async () => {
      const url = `/api/v1/users/${seed.users.antrixUser.id}/folder-permissions/${seed.folders.contracts.id}`;
      expect((await api(sa).put(url, { permission: "DOWNLOAD" })).status).toBe(200);
      expect((await api(sa).put(url, { permission: "VIEW" })).body.data.permission).toBe("VIEW");
      const detail = await api(sa).get(`/api/v1/users/${seed.users.antrixUser.id}`);
      expect(detail.body.data.folderPermissions).toEqual(
        expect.arrayContaining([expect.objectContaining({ folderName: "Contracts", permission: "VIEW" })]),
      );
      expect((await api(sa).delete(url)).status).toBe(204);
      const audits = await prisma().auditLog.findMany({ where: { action: { startsWith: "permission." } }, orderBy: { createdAt: "asc" } });
      expect(audits.map((a) => a.action)).toEqual(["permission.changed", "permission.changed", "permission.removed"]);
      // Grants are only for customer users, and only within their own customer.
      expect((await api(sa).put(`/api/v1/users/${seed.users.antrixAdmin.id}/folder-permissions/${seed.folders.contracts.id}`, { permission: "VIEW" })).status).toBe(400);
      expect((await api(sa).put(`/api/v1/users/${seed.users.antrixUser.id}/folder-permissions/${seed.folders.betaDocs.id}`, { permission: "VIEW" })).status).toBe(400);
    });
  });

  describe("audit, statistics and settings", () => {
    it("filters audit logs by customer, user, action and date", async () => {
      const user = await login(h.app, "user@antrix.test");
      await api(user).get(`/api/v1/documents/${seed.docs.report.id}/download`);
      const byCustomer = await api(sa).get(`/api/v1/audit-logs?customerId=${seed.customers.antrix.id}&action=document.download`);
      expect(byCustomer.body.data.items).toHaveLength(1);
      expect(byCustomer.body.data.items[0].actor.email).toBe("user@antrix.test");
      const byUser = await api(sa).get(`/api/v1/audit-logs?actorUserId=${user.userId}`);
      expect(byUser.body.data.items.length).toBeGreaterThanOrEqual(2);
      const future = await api(sa).get(`/api/v1/audit-logs?from=${new Date(Date.now() + 86400_000).toISOString()}`);
      expect(future.body.data.items).toHaveLength(0);
    });

    it("audit records cannot be modified or deleted, even directly in the database", async () => {
      const row = await prisma().auditLog.findFirstOrThrow();
      await expect(prisma().auditLog.update({ where: { id: row.id }, data: { outcome: "FAILURE" } })).rejects.toThrow(/append-only/);
      await expect(prisma().auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    });

    it("returns platform and storage statistics", async () => {
      const overview = await api(sa).get("/api/v1/stats/overview");
      expect(overview.body.data).toMatchObject({ activeCustomers: 2, documents: 6 });
      expect(overview.body.data.recentUploads.length).toBeGreaterThan(0);
      const storage = await api(sa).get("/api/v1/stats/storage");
      expect(storage.body.data.customers.find((c: { name: string }) => c.name === "Antrix").byStatus.AVAILABLE.count).toBe(5);
    });

    it("updates settings with an audit trail and validates input", async () => {
      const res = await api(sa).patch("/api/v1/settings", { customerUserActivityAccess: true });
      expect(res.body.data.settings.customerUserActivityAccess).toBe(true);
      expect((await api(sa).patch("/api/v1/settings", { unknownFlag: true })).status).toBe(400);
      const audit = await prisma().auditLog.findFirstOrThrow({ where: { action: "settings.changed" } });
      expect(audit.metadata).toMatchObject({ after: { customerUserActivityAccess: true } });
      const user = await login(h.app, "user@antrix.test");
      expect((await api(user).get("/api/v1/audit-logs")).status).toBe(200);
    });
  });

  it("health endpoints report component status without details", async () => {
    const live = await request(h.app).get("/api/v1/health/live");
    expect(live.body).toEqual({ status: "ok" });
    const ready = await request(h.app).get("/api/v1/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ok", checks: { database: "ok", storage: "ok" } });
    h.storage.failNext("checkConnectivity");
    const degraded = await request(h.app).get("/api/v1/health/ready");
    expect(degraded.status).toBe(503);
    expect(degraded.body.checks.storage).toBe("unavailable");
  });

  it("sets security headers and never leaks internals in errors", async () => {
    const res = await api(sa).get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    const bad = await sa.agent.post("/api/v1/customers").set("X-CSRF-Token", sa.csrf).set("Content-Type", "application/json").send("{bad json");
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts|stack/i);
  });

  it("CORS allows only configured origins", async () => {
    const allowed = await request(h.app).options("/api/v1/auth/login").set("Origin", "http://portal.test");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://portal.test");
    const denied = await request(h.app).options("/api/v1/auth/login").set("Origin", "https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
