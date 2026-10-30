import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { principal, requireRoles } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { escapeLike, pageResult, paginationSchema, toSkipTake } from "../../utils/pagination.js";
import { serializeCustomer, serializeUser } from "../../utils/serialize.js";
import { AuditAction } from "../audit/audit.service.js";

const idParam = z.object({ customerId: z.uuid() });
const listQuery = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, "Customer code must be 2-32 characters: letters, digits, '-' or '_'");
const createSchema = z.object({ name: z.string().trim().min(1).max(200), customerCode: codeSchema });
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    // Whole bytes, at most 1 PiB; null removes the limit.
    storageQuotaBytes: z.number().int().positive().max(2 ** 50).nullable().optional(),
  })
  .strict();
const assignSchema = z.object({ userId: z.uuid() });

/**
 * Customer accounts and Tekpro staff assignments.
 *   - Listing/reading: scoped by AccessPolicy (Super Admin: all; Tekpro User: assigned; customer roles: own).
 *   - Creating/updating customers and managing assignments: Super Admin only.
 */
export function customersRoutes(s: Services): Router {
  const r = Router();

  r.get("/", async (req, res) => {
    const p = principal(req);
    const q = listQuery.parse(req.query);
    const ids = await s.policy.accessibleCustomerIds(p);
    const where: Prisma.CustomerWhereInput = {
      ...(ids === "ALL" ? {} : { id: { in: ids } }),
      ...(p.role === "SUPER_ADMIN" && q.status ? { status: q.status } : {}),
      ...(p.role !== "SUPER_ADMIN" ? { status: "ACTIVE" } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: escapeLike(q.q), mode: "insensitive" } },
              { customerCode: { contains: escapeLike(q.q), mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      s.prisma.customer.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], ...toSkipTake(q) }),
      s.prisma.customer.count({ where }),
    ]);
    const counts = await s.prisma.document.groupBy({
      by: ["customerId"],
      where: { customerId: { in: items.map((c) => c.id) }, status: "AVAILABLE" },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    const byId = new Map(counts.map((c) => [c.customerId, c]));
    const platform = p.role === "SUPER_ADMIN" || p.role === "TEKPRO_USER";
    res.json({
      data: pageResult(
        items.map((c) => ({
          ...serializeCustomer(c),
          ...(platform
            ? { documentCount: byId.get(c.id)?._count._all ?? 0, totalBytes: Number(byId.get(c.id)?._sum.sizeBytes ?? 0) }
            : {}),
        })),
        total,
        q,
      ),
    });
  });

  r.post("/", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const body = createSchema.parse(req.body);
    if (await s.prisma.customer.findUnique({ where: { customerCode: body.customerCode } })) {
      throw conflict("A customer with this code already exists", "DUPLICATE");
    }
    const customer = await s.prisma.$transaction(async (tx) => {
      const c = await tx.customer.create({ data: body });
      await s.audit.fromRequest(
        req,
        { action: AuditAction.CUSTOMER_CREATED, resourceType: "Customer", resourceId: c.id, customerId: c.id, metadata: body },
        tx,
      );
      return c;
    });
    res.status(201).json({ data: serializeCustomer(customer) });
  });

  r.get("/:customerId", async (req, res) => {
    const { customerId } = idParam.parse(req.params);
    const customer = await s.policy.requireCustomerAccess(principal(req), customerId);
    res.json({ data: serializeCustomer(customer) });
  });

  r.patch("/:customerId", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { customerId } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const existing = await s.prisma.customer.findUnique({ where: { id: customerId } });
    if (!existing) throw notFound("Customer");
    const updated = await s.prisma.$transaction(async (tx) => {
      const { storageQuotaBytes, ...rest } = body;
      const c = await tx.customer.update({
        where: { id: customerId },
        data: { ...rest, ...(storageQuotaBytes !== undefined ? { storageQuotaBytes: storageQuotaBytes === null ? null : BigInt(storageQuotaBytes) } : {}) },
      });
      const fromQuota = existing.storageQuotaBytes === null ? null : Number(existing.storageQuotaBytes);
      if (storageQuotaBytes !== undefined && storageQuotaBytes !== fromQuota) {
        await s.audit.fromRequest(
          req,
          {
            action: AuditAction.STORAGE_QUOTA_CHANGED,
            resourceType: "Customer",
            resourceId: customerId,
            customerId,
            metadata: { fromBytes: fromQuota, toBytes: storageQuotaBytes },
          },
          tx,
        );
      }
      if (body.status && body.status !== existing.status) {
        if (body.status === "INACTIVE") {
          // Customer users lose access immediately.
          await tx.session.updateMany({
            where: { revokedAt: null, user: { customerId } },
            data: { revokedAt: new Date() },
          });
        }
        await s.audit.fromRequest(
          req,
          {
            action: body.status === "INACTIVE" ? AuditAction.CUSTOMER_DEACTIVATED : AuditAction.CUSTOMER_ACTIVATED,
            resourceType: "Customer",
            resourceId: customerId,
            customerId,
          },
          tx,
        );
      }
      if (body.name && body.name !== existing.name) {
        await s.audit.fromRequest(
          req,
          {
            action: AuditAction.CUSTOMER_UPDATED,
            resourceType: "Customer",
            resourceId: customerId,
            customerId,
            metadata: { from: existing.name, to: body.name },
          },
          tx,
        );
      }
      return c;
    });
    res.json({ data: serializeCustomer(updated) });
  });

  r.get("/:customerId/stats", requireRoles(s, "SUPER_ADMIN", "TEKPRO_USER"), async (req, res) => {
    const { customerId } = idParam.parse(req.params);
    await s.policy.requireCustomerAccess(principal(req), customerId);
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [byStatus, folders, uploads24h, users] = await Promise.all([
      s.prisma.document.groupBy({ by: ["status"], where: { customerId }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      s.prisma.folder.count({ where: { customerId, deletedAt: null } }),
      s.prisma.document.aggregate({
        where: { customerId, status: "AVAILABLE", availableAt: { gte: since } },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
      s.prisma.user.count({ where: { customerId, status: "ACTIVE" } }),
    ]);
    res.json({
      data: {
        folders,
        activeUsers: users,
        documentsByStatus: Object.fromEntries(
          byStatus.map((b) => [b.status, { count: b._count._all, bytes: Number(b._sum.sizeBytes ?? 0) }]),
        ),
        last24h: { uploads: uploads24h._count._all, bytes: Number(uploads24h._sum.sizeBytes ?? 0) },
      },
    });
  });

  // -------------------------------------------------------- customer users

  r.get("/:customerId/users", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { customerId } = idParam.parse(req.params);
    await s.policy.requireCustomerAccess(principal(req), customerId);
    const users = await s.prisma.user.findMany({ where: { customerId }, orderBy: [{ fullName: "asc" }, { id: "asc" }] });
    res.json({ data: users.map(serializeUser) });
  });

  // ---------------------------------------------------------- assignments

  r.get("/:customerId/assignments", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { customerId } = idParam.parse(req.params);
    await s.policy.requireCustomerAccess(principal(req), customerId);
    const rows = await s.prisma.tekproUserCustomerAssignment.findMany({
      where: { customerId },
      include: { user: true, assignedBy: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({
      data: rows.map((a) => ({ id: a.id, user: serializeUser(a.user), assignedBy: a.assignedBy, createdAt: a.createdAt })),
    });
  });

  r.post("/:customerId/assignments", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { customerId } = idParam.parse(req.params);
    const { userId } = assignSchema.parse(req.body);
    const p = principal(req);
    await s.policy.requireCustomerAccess(p, customerId);
    const user = await s.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== "TEKPRO_USER") throw badRequest("Only Agents can be assigned to customers");
    if (user.status !== "ACTIVE") throw badRequest("The user is not active");
    const existing = await s.prisma.tekproUserCustomerAssignment.findUnique({ where: { userId_customerId: { userId, customerId } } });
    if (existing) throw conflict("The user is already assigned to this customer", "DUPLICATE");
    const created = await s.prisma.$transaction(async (tx) => {
      const a = await tx.tekproUserCustomerAssignment.create({ data: { userId, customerId, assignedByUserId: p.userId } });
      await s.audit.fromRequest(
        req,
        { action: AuditAction.ASSIGNMENT_CREATED, resourceType: "Assignment", resourceId: a.id, customerId, metadata: { userId } },
        tx,
      );
      return a;
    });
    res.status(201).json({ data: { id: created.id, userId, customerId, createdAt: created.createdAt } });
  });

  r.delete("/:customerId/assignments/:userId", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { customerId, userId } = z.object({ customerId: z.uuid(), userId: z.uuid() }).parse(req.params);
    await s.policy.requireCustomerAccess(principal(req), customerId);
    await s.prisma.$transaction(async (tx) => {
      const removed = await tx.tekproUserCustomerAssignment.deleteMany({ where: { userId, customerId } });
      if (!removed.count) throw notFound("Assignment");
      await s.audit.fromRequest(
        req,
        { action: AuditAction.ASSIGNMENT_REMOVED, resourceType: "Assignment", customerId, metadata: { userId } },
        tx,
      );
    });
    res.status(204).end();
  });

  return r;
}
