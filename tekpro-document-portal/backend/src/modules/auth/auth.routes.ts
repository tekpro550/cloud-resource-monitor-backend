import { Router } from "express";
import { z } from "zod";
import { clearSessionCookie, principal, requireAuth, sessionCookieOptions } from "../../middleware/auth.js";
import type { createRateLimiters } from "../../middleware/rateLimit.js";
import type { Services } from "../../services.js";
import { AuditAction } from "../audit/audit.service.js";
import { serializeUser } from "../../utils/serialize.js";

const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) });
const forgotSchema = z.object({ email: z.string().trim().email().max(254) });
const resetSchema = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(1).max(256) });
const changeSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) });

export function authRoutes(s: Services, limiters: ReturnType<typeof createRateLimiters>): Router {
  const r = Router();

  const mePayload = async (userId: string, csrfToken: string) => {
    const user = await s.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { customer: { select: { id: true, name: true, customerCode: true } } },
    });
    const settings = await s.settings.get();
    const activityAccess =
      user.role === "SUPER_ADMIN" ||
      (user.role === "TEKPRO_USER" && settings.staffAuditAccess) ||
      (user.role === "CUSTOMER_ADMIN" && settings.customerAdminActivityAccess) ||
      (user.role === "CUSTOMER_USER" && settings.customerUserActivityAccess);
    return { user: serializeUser(user), csrfToken, features: { activityAccess } };
  };

  r.post("/login", limiters.login, async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await s.auth.login(body.email, body.password, req);
    // Session rotation: any session presented with the login request is revoked
    // and a brand-new session id is issued.
    if (req.principal) await s.auth.revokeSession(req.principal.sessionId);
    const session = await s.auth.createSession(user.id, req);
    res.cookie(s.config.session.cookieName, session.token, sessionCookieOptions(s, session.expiresAt));
    res.json({ data: await mePayload(user.id, session.csrfToken) });
  });

  r.post("/logout", async (req, res) => {
    if (req.principal) {
      await s.auth.revokeSession(req.principal.sessionId);
      await s.audit.fromRequest(req, {
        action: AuditAction.LOGOUT,
        resourceType: "User",
        resourceId: req.principal.userId,
        customerId: req.principal.customerId,
      });
    }
    clearSessionCookie(s, res);
    res.status(204).end();
  });

  r.get("/me", requireAuth, async (req, res) => {
    const p = principal(req);
    res.json({ data: await mePayload(p.userId, p.csrfToken) });
  });

  r.post("/forgot-password", limiters.passwordReset, async (req, res) => {
    const body = forgotSchema.parse(req.body);
    await s.auth.requestPasswordReset(body.email, req);
    res.status(202).json({
      data: { message: "If an active account exists for that address, a password reset link has been sent." },
    });
  });

  r.post("/reset-password", limiters.passwordReset, async (req, res) => {
    const body = resetSchema.parse(req.body);
    await s.auth.resetPassword(body.token, body.newPassword, req);
    if (req.principal) clearSessionCookie(s, res);
    res.json({ data: { message: "Your password has been updated. You can now sign in." } });
  });

  r.post("/change-password", requireAuth, async (req, res) => {
    const body = changeSchema.parse(req.body);
    const p = principal(req);
    await s.auth.changePassword(p, body.currentPassword, body.newPassword, req);
    // All sessions were revoked; issue a fresh one for this browser.
    const session = await s.auth.createSession(p.userId, req);
    res.cookie(s.config.session.cookieName, session.token, sessionCookieOptions(s, session.expiresAt));
    res.json({ data: await mePayload(p.userId, session.csrfToken) });
  });

  return r;
}
