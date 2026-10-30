import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { principal } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { pageResult, paginationSchema, toSkipTake } from "../../utils/pagination.js";
import { AccessDeniedError } from "../permissions/accessPolicy.js";
import { CUSTOMER_VISIBLE_ACTIONS } from "./audit.service.js";

const listQuery = paginationSchema.extend({
  customerId: z.uuid().optional(),
  actorUserId: z.uuid().optional(),
  action: z.string().trim().max(100).optional(),
  outcome: z.enum(["SUCCESS", "FAILURE", "DENIED"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Read-only audit access. Records are append-only (enforced by a database
 * trigger) and there is no endpoint that modifies them.
 *   SUPER_ADMIN     all records
 *   TEKPRO_USER     records of assigned customers, when staffAuditAccess is enabled
 *   CUSTOMER_ADMIN  downloads/logins by users of their own organisation, when enabled
 *   CUSTOMER_USER   their own downloads/logins, when enabled
 */
export function auditRoutes(s: Services): Router {
  const r = Router();

  r.get("/", async (req, res) => {
    const p = principal(req);
    const q = listQuery.parse(req.query);
    const settings = await s.settings.get();
    const deny = (reason: string) => new AccessDeniedError(403, "Activity records are not available for your account", { resourceType: "AuditLog", reason });

    const filters: Prisma.AuditLogWhereInput[] = [];
    if (q.customerId) filters.push({ customerId: q.customerId });
    if (q.actorUserId) filters.push({ actorUserId: q.actorUserId });
    if (q.action) filters.push({ action: { startsWith: q.action } });
    if (q.outcome) filters.push({ outcome: q.outcome });
    if (q.from || q.to) filters.push({ createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } });

    switch (p.role) {
      case "SUPER_ADMIN":
        break;
      case "TEKPRO_USER": {
        if (!settings.staffAuditAccess) throw deny("staff audit access disabled");
        const ids = await s.policy.accessibleCustomerIds(p);
        filters.push({ customerId: { in: ids === "ALL" ? undefined : ids } });
        break;
      }
      case "CUSTOMER_ADMIN":
        if (!settings.customerAdminActivityAccess) throw deny("customer admin activity access disabled");
        filters.push({ customerId: p.customerId!, action: { in: CUSTOMER_VISIBLE_ACTIONS }, actor: { customerId: p.customerId! } });
        break;
      case "CUSTOMER_USER":
        if (!settings.customerUserActivityAccess) throw deny("customer user activity access disabled");
        filters.push({ actorUserId: p.userId, action: { in: CUSTOMER_VISIBLE_ACTIONS } });
        break;
    }

    const where: Prisma.AuditLogWhereInput = { AND: filters };
    const [items, total] = await Promise.all([
      s.prisma.auditLog.findMany({
        where,
        include: {
          actor: { select: { id: true, fullName: true, email: true, role: true } },
          customer: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...toSkipTake(q),
      }),
      s.prisma.auditLog.count({ where }),
    ]);
    const platform = p.role === "SUPER_ADMIN" || p.role === "TEKPRO_USER";
    res.json({
      data: pageResult(
        items.map((a) => ({
          id: a.id,
          createdAt: a.createdAt,
          action: a.action,
          outcome: a.outcome,
          resourceType: a.resourceType,
          resourceId: a.resourceId,
          customer: a.customer,
          actor: a.actor ? { id: a.actor.id, fullName: a.actor.fullName, ...(platform ? { email: a.actor.email, role: a.actor.role } : {}) } : null,
          ...(platform ? { requestId: a.requestId, ipAddress: p.role === "SUPER_ADMIN" ? a.ipAddress : undefined, metadata: a.metadata } : {}),
          ...(!platform && a.metadata && typeof a.metadata === "object" && "displayName" in a.metadata
            ? { documentName: (a.metadata as { displayName?: string }).displayName }
            : {}),
        })),
        total,
        q,
      ),
    });
  });

  return r;
}
