import type { Prisma, Role } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { principal, requireRoles } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { escapeLike, pageResult, paginationSchema, toSkipTake } from "../../utils/pagination.js";
import { serializeUser } from "../../utils/serialize.js";
import { AuditAction } from "../audit/audit.service.js";
import { isCustomerRole, isPlatformRole } from "../permissions/accessPolicy.js";

const roleEnum = z.enum(["SUPER_ADMIN", "TEKPRO_USER", "CUSTOMER_ADMIN", "CUSTOMER_USER"]);
const idParam = z.object({ userId: z.uuid() });

const listQuery = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  role: roleEnum.optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  customerId: z.uuid().optional(),
  scope: z.enum(["staff", "customer"]).optional(),
});

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  fullName: z.string().trim().min(1).max(200),
  role: roleEnum,
  customerId: z.uuid().nullish(),
});

const updateSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    role: roleEnum.optional(),
  })
  .strict();

const permissionSchema = z.object({ permission: z.enum(["NONE", "VIEW", "DOWNLOAD"]) });

/**
 * User administration. Every endpoint is restricted to the Super Admin.
 * Role/customer rules:
 *   SUPER_ADMIN, TEKPRO_USER         -> no customer (platform users)
 *   CUSTOMER_ADMIN, CUSTOMER_USER    -> exactly one customer, fixed at creation
 * Role changes are only allowed within the same category, and never on oneself.
 */
export function usersRoutes(s: Services): Router {
  const r = Router();
  r.use(requireRoles(s, "SUPER_ADMIN"));

  const loadUser = async (userId: string) => {
    const user = await s.prisma.user.findUnique({
      where: { id: userId },
      include: { customer: { select: { id: true, name: true, customerCode: true } } },
    });
    if (!user) throw notFound("User");
    return user;
  };

  const passwordLink = async (userId: string, purpose: "INVITE" | "RESET", user: { email: string; fullName: string }) => {
    const issued = await s.auth.issuePasswordToken(userId, purpose);
    let emailSent = false;
    if (s.mailer.enabled) {
      try {
        await s.auth.sendPasswordEmail(user, issued.link, purpose);
        emailSent = true;
      } catch (err) {
        s.logger.error({ err, userId }, "Failed to send password email");
      }
    }
    return { emailSent, ...(s.config.allowAdminResetLinks ? { link: issued.link } : {}) };
  };

  r.get("/", async (req, res) => {
    const q = listQuery.parse(req.query);
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.scope === "staff" ? { role: { in: ["SUPER_ADMIN", "TEKPRO_USER"] as Role[] } } : {}),
      ...(q.scope === "customer" ? { role: { in: ["CUSTOMER_ADMIN", "CUSTOMER_USER"] as Role[] } } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.q
        ? {
            OR: [
              { email: { contains: escapeLike(q.q), mode: "insensitive" } },
              { fullName: { contains: escapeLike(q.q), mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      s.prisma.user.findMany({
        where,
        include: { customer: { select: { id: true, name: true, customerCode: true } } },
        orderBy: [{ fullName: "asc" }, { id: "asc" }],
        ...toSkipTake(q),
      }),
      s.prisma.user.count({ where }),
    ]);
    res.json({ data: pageResult(items.map(serializeUser), total, q) });
  });

  r.post("/", async (req, res) => {
    const body = createSchema.parse(req.body);
    const p = principal(req);
    if (isPlatformRole(body.role) && body.customerId) throw badRequest("Tekpro users cannot belong to a customer");
    if (isCustomerRole(body.role)) {
      if (!body.customerId) throw badRequest("Customer users must be associated with a customer");
      const customer = await s.prisma.customer.findUnique({ where: { id: body.customerId } });
      if (!customer) throw badRequest("Customer does not exist");
    }
    if (await s.prisma.user.findUnique({ where: { email: body.email } })) {
      throw conflict("A user with this email address already exists", "DUPLICATE");
    }
    const user = await s.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: body.email,
          fullName: body.fullName,
          role: body.role,
          customerId: isCustomerRole(body.role) ? body.customerId! : null,
        },
        include: { customer: { select: { id: true, name: true, customerCode: true } } },
      });
      await s.audit.fromRequest(
        req,
        {
          action: AuditAction.USER_CREATED,
          resourceType: "User",
          resourceId: created.id,
          customerId: created.customerId,
          metadata: { email: created.email, role: created.role, createdBy: p.userId },
        },
        tx,
      );
      return created;
    });
    const invite = await passwordLink(user.id, "INVITE", user);
    res.status(201).json({ data: { user: serializeUser(user), invite } });
  });

  r.get("/:userId", async (req, res) => {
    const { userId } = idParam.parse(req.params);
    const user = await loadUser(userId);
    const [assignments, folderPermissions] = await Promise.all([
      user.role === "TEKPRO_USER"
        ? s.prisma.tekproUserCustomerAssignment.findMany({
            where: { userId },
            include: { customer: { select: { id: true, name: true, customerCode: true, status: true } } },
            orderBy: { createdAt: "asc" },
          })
        : [],
      user.role === "CUSTOMER_USER"
        ? s.prisma.customerUserFolderPermission.findMany({
            where: { userId },
            include: { folder: { select: { id: true, name: true, parentFolderId: true, deletedAt: true } } },
          })
        : [],
    ]);
    res.json({
      data: {
        user: serializeUser(user),
        assignments: assignments.map((a) => ({ id: a.id, customer: a.customer, createdAt: a.createdAt })),
        folderPermissions: folderPermissions
          .filter((fp) => !fp.folder.deletedAt)
          .map((fp) => ({ folderId: fp.folderId, folderName: fp.folder.name, permission: fp.permission, updatedAt: fp.updatedAt })),
      },
    });
  });

  r.patch("/:userId", async (req, res) => {
    const { userId } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const p = principal(req);
    const user = await loadUser(userId);

    if (body.role && body.role !== user.role) {
      if (userId === p.userId) throw badRequest("You cannot change your own role");
      if (isPlatformRole(body.role) !== isPlatformRole(user.role)) {
        throw badRequest("A user cannot be moved between Tekpro and customer roles; create a new account instead");
      }
      if (user.role === "SUPER_ADMIN") await assertAnotherActiveSuperAdmin(userId);
    }
    if (body.email && body.email !== user.email && (await s.prisma.user.findUnique({ where: { email: body.email } }))) {
      throw conflict("A user with this email address already exists", "DUPLICATE");
    }

    const updated = await s.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { fullName: body.fullName, email: body.email, role: body.role },
        include: { customer: { select: { id: true, name: true, customerCode: true } } },
      });
      if (body.role && body.role !== user.role) {
        // Privilege change: invalidate every existing session of the user.
        await s.auth.revokeAllSessions(userId, tx);
        if (body.role === "SUPER_ADMIN") await tx.tekproUserCustomerAssignment.deleteMany({ where: { userId } });
        if (body.role === "CUSTOMER_ADMIN") await tx.customerUserFolderPermission.deleteMany({ where: { userId } });
        await s.audit.fromRequest(
          req,
          {
            action: AuditAction.USER_ROLE_CHANGED,
            resourceType: "User",
            resourceId: userId,
            customerId: user.customerId,
            metadata: { from: user.role, to: body.role },
          },
          tx,
        );
      }
      if (body.email && body.email !== user.email) await s.auth.revokeAllSessions(userId, tx);
      await s.audit.fromRequest(
        req,
        {
          action: AuditAction.USER_UPDATED,
          resourceType: "User",
          resourceId: userId,
          customerId: user.customerId,
          metadata: { changed: Object.keys(body), emailChanged: !!body.email && body.email !== user.email },
        },
        tx,
      );
      return u;
    });
    res.json({ data: serializeUser(updated) });
  });

  const assertAnotherActiveSuperAdmin = async (excludingUserId: string) => {
    const others = await s.prisma.user.count({ where: { role: "SUPER_ADMIN", status: "ACTIVE", id: { not: excludingUserId } } });
    if (others === 0) throw badRequest("At least one active Super Admin must remain");
  };

  r.post("/:userId/deactivate", async (req, res) => {
    const { userId } = idParam.parse(req.params);
    const p = principal(req);
    if (userId === p.userId) throw badRequest("You cannot deactivate your own account");
    const user = await loadUser(userId);
    if (user.role === "SUPER_ADMIN") await assertAnotherActiveSuperAdmin(userId);
    const updated = await s.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { status: "INACTIVE" },
        include: { customer: { select: { id: true, name: true, customerCode: true } } },
      });
      await s.auth.revokeAllSessions(userId, tx);
      await tx.passwordToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
      await s.audit.fromRequest(
        req,
        { action: AuditAction.USER_DEACTIVATED, resourceType: "User", resourceId: userId, customerId: user.customerId },
        tx,
      );
      return u;
    });
    res.json({ data: serializeUser(updated) });
  });

  r.post("/:userId/activate", async (req, res) => {
    const { userId } = idParam.parse(req.params);
    const user = await loadUser(userId);
    const updated = await s.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { status: "ACTIVE", failedLoginCount: 0, lockedUntil: null },
        include: { customer: { select: { id: true, name: true, customerCode: true } } },
      });
      await s.audit.fromRequest(
        req,
        { action: AuditAction.USER_ACTIVATED, resourceType: "User", resourceId: userId, customerId: user.customerId },
        tx,
      );
      return u;
    });
    res.json({ data: serializeUser(updated) });
  });

  r.post("/:userId/password-reset", async (req, res) => {
    const { userId } = idParam.parse(req.params);
    const user = await loadUser(userId);
    if (user.status !== "ACTIVE") throw badRequest("Activate the account before sending a password link");
    const purpose = user.passwordHash ? "RESET" : "INVITE";
    const result = await passwordLink(userId, purpose, user);
    await s.audit.fromRequest(req, {
      action: AuditAction.USER_PASSWORD_RESET_TRIGGERED,
      resourceType: "User",
      resourceId: userId,
      customerId: user.customerId,
      metadata: { purpose, emailSent: result.emailSent },
    });
    res.json({ data: result });
  });

  // ---------------------------------------------- customer folder permissions

  const permParams = z.object({ userId: z.uuid(), folderId: z.uuid() });

  const loadCustomerUserAndFolder = async (userId: string, folderId: string) => {
    const user = await loadUser(userId);
    if (user.role !== "CUSTOMER_USER") throw badRequest("Folder permissions apply only to Customer Users");
    const folder = await s.prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.deletedAt || folder.customerId !== user.customerId) {
      throw badRequest("The folder does not belong to this user's customer");
    }
    return { user, folder };
  };

  r.put("/:userId/folder-permissions/:folderId", async (req, res) => {
    const { userId, folderId } = permParams.parse(req.params);
    const { permission } = permissionSchema.parse(req.body);
    const { user, folder } = await loadCustomerUserAndFolder(userId, folderId);
    const p = principal(req);
    const result = await s.prisma.$transaction(async (tx) => {
      const existing = await tx.customerUserFolderPermission.findUnique({ where: { userId_folderId: { userId, folderId } } });
      const saved = await tx.customerUserFolderPermission.upsert({
        where: { userId_folderId: { userId, folderId } },
        create: { userId, folderId, customerId: folder.customerId, permission, grantedByUserId: p.userId },
        update: { permission, grantedByUserId: p.userId },
      });
      await s.audit.fromRequest(
        req,
        {
          action: AuditAction.PERMISSION_CHANGED,
          resourceType: "Folder",
          resourceId: folderId,
          customerId: folder.customerId,
          metadata: { userId, from: existing?.permission ?? null, to: permission, userEmail: user.email },
        },
        tx,
      );
      return saved;
    });
    res.json({ data: { userId, folderId, permission: result.permission, updatedAt: result.updatedAt } });
  });

  r.delete("/:userId/folder-permissions/:folderId", async (req, res) => {
    const { userId, folderId } = permParams.parse(req.params);
    const { folder } = await loadCustomerUserAndFolder(userId, folderId);
    await s.prisma.$transaction(async (tx) => {
      const removed = await tx.customerUserFolderPermission.deleteMany({ where: { userId, folderId } });
      if (removed.count) {
        await s.audit.fromRequest(
          req,
          {
            action: AuditAction.PERMISSION_REMOVED,
            resourceType: "Folder",
            resourceId: folderId,
            customerId: folder.customerId,
            metadata: { userId },
          },
          tx,
        );
      }
    });
    res.status(204).end();
  });

  return r;
}

