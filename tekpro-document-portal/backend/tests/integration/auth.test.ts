import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createTestApp, createUser, login, PASSWORD, prisma, resetDb, type TestHarness } from "../helpers/testApp.js";

describe("authentication", () => {
  let h: TestHarness;

  beforeEach(async () => {
    await resetDb();
    h = createTestApp({ LOGIN_MAX_FAILED_ATTEMPTS: "3", SESSION_IDLE_TIMEOUT_SECONDS: "60" });
    await createUser({ email: "staff@tekpro.test", role: "TEKPRO_USER" });
  });

  it("logs in with valid credentials, sets a secure HttpOnly cookie and returns the user without secrets", async () => {
    const res = await request(h.app).post("/api/v1/auth/login").send({ email: "STAFF@tekpro.test", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("staff@tekpro.test");
    expect(res.body.data.user).not.toHaveProperty("passwordHash");
    expect(res.body.data.csrfToken).toEqual(expect.any(String));
    const cookie = res.headers["set-cookie"]![0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const audit = await prisma().auditLog.findFirst({ where: { action: "auth.login.succeeded" } });
    expect(audit?.outcome).toBe("SUCCESS");
  });

  it("stores only a hash of the session token", async () => {
    const res = await request(h.app).post("/api/v1/auth/login").send({ email: "staff@tekpro.test", password: PASSWORD });
    const token = /tdp_session=([^;]+)/.exec(res.headers["set-cookie"]![0]!)![1]!;
    const session = await prisma().session.findFirstOrThrow();
    expect(session.tokenHash).not.toContain(token);
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects invalid credentials with a generic message and audits the failure", async () => {
    const wrong = await request(h.app).post("/api/v1/auth/login").send({ email: "staff@tekpro.test", password: "nope-Nope-123" });
    const unknown = await request(h.app).post("/api/v1/auth/login").send({ email: "ghost@tekpro.test", password: "nope-Nope-123" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(await prisma().auditLog.count({ where: { action: "auth.login.failed" } })).toBe(2);
  });

  it("locks the account after repeated failures, even for the correct password", async () => {
    for (let i = 0; i < 3; i++) {
      await request(h.app).post("/api/v1/auth/login").send({ email: "staff@tekpro.test", password: "Wrong-password-1" });
    }
    const res = await request(h.app).post("/api/v1/auth/login").send({ email: "staff@tekpro.test", password: PASSWORD });
    expect(res.status).toBe(401);
    const user = await prisma().user.findUniqueOrThrow({ where: { email: "staff@tekpro.test" } });
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not let inactive accounts log in", async () => {
    await createUser({ email: "gone@tekpro.test", role: "TEKPRO_USER", status: "INACTIVE" });
    const res = await request(h.app).post("/api/v1/auth/login").send({ email: "gone@tekpro.test", password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it("does not let users of an inactive customer log in", async () => {
    const c = await prisma().customer.create({ data: { name: "Dormant", customerCode: "DORMANT", status: "INACTIVE" } });
    await createUser({ email: "u@dormant.test", role: "CUSTOMER_USER", customerId: c.id });
    const res = await request(h.app).post("/api/v1/auth/login").send({ email: "u@dormant.test", password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated access to protected APIs", async () => {
    for (const url of ["/api/v1/auth/me", "/api/v1/customers", "/api/v1/users", "/api/v1/audit-logs"]) {
      const res = await request(h.app).get(url);
      expect(res.status, url).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("logs out and invalidates the session server-side", async () => {
    const u = await login(h.app, "staff@tekpro.test");
    expect((await u.agent.get("/api/v1/auth/me")).status).toBe(200);
    const cookieValue = (await prisma().session.findFirstOrThrow()).id;
    expect((await api(u).post("/api/v1/auth/logout")).status).toBe(204);
    expect((await u.agent.get("/api/v1/auth/me")).status).toBe(401);
    const session = await prisma().session.findUniqueOrThrow({ where: { id: cookieValue } });
    expect(session.revokedAt).not.toBeNull();
  });

  it("rejects a replayed session cookie after logout", async () => {
    const res = await request(h.app).post("/api/v1/auth/login").send({ email: "staff@tekpro.test", password: PASSWORD });
    const cookie = res.headers["set-cookie"]![0]!.split(";")[0]!;
    await request(h.app).post("/api/v1/auth/logout").set("Cookie", cookie).set("X-CSRF-Token", res.body.data.csrfToken);
    const replay = await request(h.app).get("/api/v1/auth/me").set("Cookie", cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("expires idle sessions", async () => {
    const u = await login(h.app, "staff@tekpro.test");
    await prisma().session.updateMany({ data: { lastSeenAt: new Date(Date.now() - 120_000) } });
    const res = await u.agent.get("/api/v1/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("expires sessions at their absolute lifetime", async () => {
    const u = await login(h.app, "staff@tekpro.test");
    await prisma().session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await u.agent.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("invalidates sessions immediately when the account is deactivated", async () => {
    const u = await login(h.app, "staff@tekpro.test");
    await prisma().user.update({ where: { email: "staff@tekpro.test" }, data: { status: "INACTIVE" } });
    expect((await u.agent.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("rotates the session on login", async () => {
    const u = await login(h.app, "staff@tekpro.test");
    const first = await prisma().session.findFirstOrThrow();
    await u.agent.post("/api/v1/auth/login").send({ email: "staff@tekpro.test", password: PASSWORD });
    const old = await prisma().session.findUniqueOrThrow({ where: { id: first.id } });
    expect(old.revokedAt).not.toBeNull();
    expect(await prisma().session.count({ where: { revokedAt: null } })).toBe(1);
  });

  it("requires the CSRF token for state-changing requests", async () => {
    const u = await login(h.app, "staff@tekpro.test");
    const res = await u.agent.post("/api/v1/auth/logout");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_INVALID");
    const bad = await u.agent.post("/api/v1/auth/logout").set("X-CSRF-Token", "forged");
    expect(bad.status).toBe(403);
  });

  it("rejects state-changing requests from foreign origins", async () => {
    const res = await request(h.app)
      .post("/api/v1/auth/login")
      .set("Origin", "https://evil.example")
      .send({ email: "staff@tekpro.test", password: PASSWORD });
    expect(res.status).toBe(403);
  });

  describe("password reset", () => {
    const tokenFromMail = () => {
      const text = h.mailer.sent.at(-1)!.text;
      return /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;
    };

    it("responds identically for known and unknown addresses", async () => {
      const a = await request(h.app).post("/api/v1/auth/forgot-password").send({ email: "staff@tekpro.test" });
      const b = await request(h.app).post("/api/v1/auth/forgot-password").send({ email: "nobody@tekpro.test" });
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(a.body).toEqual(b.body);
      expect(h.mailer.sent).toHaveLength(1);
    });

    it("resets the password with a single-use token and revokes existing sessions", async () => {
      const u = await login(h.app, "staff@tekpro.test");
      await request(h.app).post("/api/v1/auth/forgot-password").send({ email: "staff@tekpro.test" });
      const token = tokenFromMail();
      const stored = await prisma().passwordToken.findFirstOrThrow();
      expect(stored.tokenHash).not.toBe(token);

      const newPassword = "Brand-New-Passphrase-42";
      const res = await request(h.app).post("/api/v1/auth/reset-password").send({ token, newPassword });
      expect(res.status).toBe(200);
      expect((await u.agent.get("/api/v1/auth/me")).status).toBe(401);
      await login(h.app, "staff@tekpro.test", newPassword);
      expect((await request(h.app).post("/api/v1/auth/login").send({ email: "staff@tekpro.test", password: PASSWORD })).status).toBe(401);

      const reuse = await request(h.app).post("/api/v1/auth/reset-password").send({ token, newPassword: "Another-Passphrase-77" });
      expect(reuse.status).toBe(400);
    });

    it("rejects expired tokens and weak passwords", async () => {
      await request(h.app).post("/api/v1/auth/forgot-password").send({ email: "staff@tekpro.test" });
      const token = tokenFromMail();
      const weak = await request(h.app).post("/api/v1/auth/reset-password").send({ token, newPassword: "short" });
      expect(weak.status).toBe(400);
      await prisma().passwordToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await request(h.app).post("/api/v1/auth/reset-password").send({ token, newPassword: "Brand-New-Passphrase-42" });
      expect(expired.status).toBe(400);
    });
  });

  it("changes password, revoking other sessions but keeping the current browser signed in", async () => {
    const a = await login(h.app, "staff@tekpro.test");
    const b = await login(h.app, "staff@tekpro.test");
    const res = await api(a).post("/api/v1/auth/change-password", { currentPassword: PASSWORD, newPassword: "Changed-Passphrase-88" });
    expect(res.status).toBe(200);
    expect((await a.agent.get("/api/v1/auth/me")).status).toBe(200);
    expect((await b.agent.get("/api/v1/auth/me")).status).toBe(401);
  });

  it("rate-limits repeated login attempts", async () => {
    const limited = createTestApp({ RATE_LIMIT_LOGIN_MAX: "2" });
    const attempt = () => request(limited.app).post("/api/v1/auth/login").send({ email: "x@tekpro.test", password: "Wrong-password-1" });
    await attempt();
    await attempt();
    const third = await attempt();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("RATE_LIMITED");
  });
});
