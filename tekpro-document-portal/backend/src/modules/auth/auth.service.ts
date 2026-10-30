import type { PasswordTokenPurpose, Prisma, User } from "@prisma/client";
import type { Request } from "express";
import type { AppContext, Principal } from "../../types/context.js";
import { hashToken, randomToken } from "../../utils/crypto.js";
import { AppError, badRequest } from "../../utils/errors.js";
import { AuditAction, type AuditService } from "../audit/audit.service.js";
import { hashPassword, validatePasswordStrength, verifyAgainstDummy, verifyPassword } from "./password.js";

export const GENERIC_LOGIN_ERROR = "Invalid email or password, or the account is not available.";

export type SessionLookup =
  | { ok: true; principal: Principal }
  | { ok: false; reason: "missing" | "expired" | "revoked" | "inactive" };

export class AuthService {
  constructor(
    private readonly ctx: AppContext,
    private readonly audit: AuditService,
  ) {}

  private hash(token: string) {
    return hashToken(token, this.ctx.config.sessionSecret);
  }

  // -------------------------------------------------------------- sessions

  async createSession(userId: string, req: Request): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + this.ctx.config.session.ttlSeconds * 1000);
    await this.ctx.prisma.session.create({
      data: {
        tokenHash: this.hash(token),
        csrfToken,
        userId,
        expiresAt,
        ipAddress: req.ip ?? null,
        userAgent: req.get("user-agent")?.slice(0, 300) ?? null,
      },
    });
    return { token, csrfToken, expiresAt };
  }

  /**
   * Resolves a session cookie into a principal. The user, role, status and
   * customer are re-read from the database on every request so deactivation,
   * role changes and customer deactivation take effect immediately.
   */
  async lookupSession(token: string | undefined): Promise<SessionLookup> {
    if (!token || token.length > 200) return { ok: false, reason: "missing" };
    const session = await this.ctx.prisma.session.findUnique({
      where: { tokenHash: this.hash(token) },
      include: { user: { include: { customer: { select: { status: true } } } } },
    });
    if (!session) return { ok: false, reason: "missing" };
    if (session.revokedAt) return { ok: false, reason: "revoked" };
    const now = Date.now();
    const idleLimit = session.lastSeenAt.getTime() + this.ctx.config.session.idleTimeoutSeconds * 1000;
    if (session.expiresAt.getTime() <= now || idleLimit <= now) {
      await this.ctx.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return { ok: false, reason: "expired" };
    }
    const u = session.user;
    if (u.status !== "ACTIVE" || (u.customerId && u.customer?.status !== "ACTIVE")) {
      await this.ctx.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      return { ok: false, reason: "inactive" };
    }
    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.ctx.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    return {
      ok: true,
      principal: {
        userId: u.id,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        customerId: u.customerId,
        sessionId: session.id,
        csrfToken: session.csrfToken,
      },
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.ctx.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Revokes every active session of a user (deactivation, role or password change). */
  async revokeAllSessions(userId: string, db: Prisma.TransactionClient | AppContext["prisma"] = this.ctx.prisma, exceptSessionId?: string) {
    await db.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }

  // ----------------------------------------------------------------- login

  async login(emailRaw: string, password: string, req: Request): Promise<User> {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.ctx.prisma.user.findUnique({ where: { email }, include: { customer: { select: { status: true } } } });
    const fail = async (reason: string, userId?: string, customerId?: string | null) => {
      await this.audit.fromRequest(req, {
        action: AuditAction.LOGIN_FAILED,
        resourceType: "User",
        resourceId: userId ?? null,
        actorUserId: userId ?? null,
        customerId: customerId ?? null,
        outcome: "FAILURE",
        metadata: { reason, attemptedEmail: email.slice(0, 254) },
      });
      return new AppError(401, "UNAUTHENTICATED", GENERIC_LOGIN_ERROR);
    };

    if (!user || !user.passwordHash) {
      await verifyAgainstDummy(password);
      throw await fail(user ? "password_not_set" : "unknown_email", user?.id, user?.customerId);
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await verifyAgainstDummy(password);
      throw await fail("account_locked", user.id, user.customerId);
    }
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      const failures = user.failedLoginCount + 1;
      const lock = failures >= this.ctx.config.login.maxFailedAttempts;
      await this.ctx.prisma.user.update({
        where: { id: user.id },
        data: lock
          ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + this.ctx.config.login.lockoutSeconds * 1000) }
          : { failedLoginCount: failures },
      });
      throw await fail(lock ? "bad_password_account_locked" : "bad_password", user.id, user.customerId);
    }
    if (user.status !== "ACTIVE") throw await fail("user_inactive", user.id, user.customerId);
    if (user.customerId && user.customer?.status !== "ACTIVE") throw await fail("customer_inactive", user.id, user.customerId);

    const updated = await this.ctx.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.fromRequest(req, {
      action: AuditAction.LOGIN_SUCCEEDED,
      resourceType: "User",
      resourceId: user.id,
      actorUserId: user.id,
      customerId: user.customerId,
    });
    return updated;
  }

  // -------------------------------------------------------- password links

  /** Creates a single-use password token, invalidating older unused ones. Returns the raw token. */
  async issuePasswordToken(userId: string, purpose: PasswordTokenPurpose, db: Prisma.TransactionClient | AppContext["prisma"] = this.ctx.prisma) {
    const token = randomToken(32);
    const ttl = purpose === "INVITE" ? this.ctx.config.inviteTtlSeconds : this.ctx.config.passwordResetTtlSeconds;
    await db.passwordToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    await db.passwordToken.create({
      data: { tokenHash: this.hash(token), userId, purpose, expiresAt: new Date(Date.now() + ttl * 1000) },
    });
    return { token, link: `${this.ctx.config.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`, purpose };
  }

  async sendPasswordEmail(user: Pick<User, "email" | "fullName">, link: string, purpose: PasswordTokenPurpose) {
    const invite = purpose === "INVITE";
    const ttlMinutes = Math.round((invite ? this.ctx.config.inviteTtlSeconds : this.ctx.config.passwordResetTtlSeconds) / 60);
    await this.ctx.mailer.send({
      to: user.email,
      subject: invite ? "Your Tekpro Document Portal account" : "Reset your Tekpro Document Portal password",
      text: [
        `Hello ${user.fullName},`,
        "",
        invite
          ? "An account has been created for you on the Tekpro Document Portal. Use the link below to set your password."
          : "A password reset was requested for your Tekpro Document Portal account. Use the link below to choose a new password.",
        "",
        link,
        "",
        `This link can be used once and expires in ${ttlMinutes} minutes.`,
        "If you did not expect this message, you can ignore it.",
      ].join("\n"),
    });
  }

  /** Always resolves the same way regardless of whether the email exists. */
  async requestPasswordReset(emailRaw: string, req: Request): Promise<void> {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.ctx.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== "ACTIVE") {
      await this.audit.fromRequest(req, {
        action: AuditAction.PASSWORD_RESET_REQUESTED,
        resourceType: "User",
        outcome: "FAILURE",
        metadata: { reason: user ? "user_inactive" : "unknown_email" },
        actorUserId: null,
      });
      return;
    }
    const { link } = await this.issuePasswordToken(user.id, "RESET");
    try {
      await this.sendPasswordEmail(user, link, "RESET");
    } catch (err) {
      this.ctx.logger.error({ err, userId: user.id }, "Failed to send password reset email");
    }
    await this.audit.fromRequest(req, {
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      resourceType: "User",
      resourceId: user.id,
      actorUserId: null,
      customerId: user.customerId,
    });
  }

  async resetPassword(token: string, newPassword: string, req: Request): Promise<void> {
    const record = await this.ctx.prisma.passwordToken.findUnique({ where: { tokenHash: this.hash(token) }, include: { user: true } });
    const invalid = async (reason: string) => {
      await this.audit.fromRequest(req, {
        action: AuditAction.PASSWORD_RESET_FAILED,
        resourceType: "User",
        resourceId: record?.userId ?? null,
        outcome: "FAILURE",
        actorUserId: null,
        metadata: { reason },
      });
      return new AppError(400, "VALIDATION_ERROR", "This password link is invalid or has expired. Please request a new one.");
    };
    if (!record) throw await invalid("unknown_token");
    if (record.usedAt) throw await invalid("token_used");
    if (record.expiresAt.getTime() <= Date.now()) throw await invalid("token_expired");
    if (record.user.status !== "ACTIVE") throw await invalid("user_inactive");
    validatePasswordStrength(newPassword, this.ctx.config.passwordMinLength, record.user.email);

    const passwordHash = await hashPassword(newPassword);
    await this.ctx.prisma.$transaction(async (tx) => {
      // Single use: claim the token atomically so concurrent submissions cannot both succeed.
      const claimed = await tx.passwordToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw badRequest("This password link is invalid or has expired. Please request a new one.");
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      });
      await this.revokeAllSessions(record.userId, tx);
      await this.audit.record(
        {
          action: AuditAction.PASSWORD_RESET_COMPLETED,
          resourceType: "User",
          resourceId: record.userId,
          actorUserId: record.userId,
          customerId: record.user.customerId,
          requestId: String(req.id),
          ipAddress: req.ip,
          metadata: { purpose: record.purpose },
        },
        tx,
      );
    });
  }

  async changePassword(p: Principal, currentPassword: string, newPassword: string, req: Request): Promise<void> {
    const user = await this.ctx.prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
      await this.audit.fromRequest(req, {
        action: AuditAction.PASSWORD_CHANGED,
        resourceType: "User",
        resourceId: user.id,
        outcome: "FAILURE",
        customerId: user.customerId,
        metadata: { reason: "bad_current_password" },
      });
      throw badRequest("Current password is incorrect");
    }
    validatePasswordStrength(newPassword, this.ctx.config.passwordMinLength, user.email);
    const passwordHash = await hashPassword(newPassword);
    await this.ctx.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: new Date() } });
      await this.revokeAllSessions(user.id, tx);
      await this.audit.fromRequest(
        req,
        { action: AuditAction.PASSWORD_CHANGED, resourceType: "User", resourceId: user.id, customerId: user.customerId },
        tx,
      );
    });
  }
}
