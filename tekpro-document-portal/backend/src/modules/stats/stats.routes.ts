import { Router } from "express";
import { requireRoles } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { AuditAction } from "../audit/audit.service.js";

const ADMIN_ACTION_PREFIXES = ["user.", "customer.", "assignment.", "permission.", "settings.", "security."];

/** Platform statistics for the Super Admin dashboard and storage page. */
export function statsRoutes(s: Services): Router {
  const r = Router();
  r.use(requireRoles(s, "SUPER_ADMIN"));

  r.get("/overview", async (_req, res) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [customers, activeUsers, docs, uploads24h, recentUploads, recentDownloads, recentAdmin] = await Promise.all([
      s.prisma.customer.count({ where: { status: "ACTIVE" } }),
      s.prisma.user.count({ where: { status: "ACTIVE" } }),
      s.prisma.document.aggregate({ where: { status: "AVAILABLE" }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      s.prisma.document.aggregate({ where: { status: "AVAILABLE", availableAt: { gte: since } }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      s.prisma.document.findMany({
        where: { status: "AVAILABLE" },
        orderBy: { availableAt: "desc" },
        take: 8,
        include: { customer: { select: { id: true, name: true } }, uploadedBy: { select: { id: true, fullName: true } } },
      }),
      s.prisma.auditLog.findMany({
        where: { action: AuditAction.DOWNLOAD_LINK_ISSUED },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { actor: { select: { id: true, fullName: true } }, customer: { select: { id: true, name: true } } },
      }),
      s.prisma.auditLog.findMany({
        where: { OR: ADMIN_ACTION_PREFIXES.map((prefix) => ({ action: { startsWith: prefix } })) },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { actor: { select: { id: true, fullName: true } }, customer: { select: { id: true, name: true } } },
      }),
    ]);
    const event = (a: (typeof recentAdmin)[number]) => ({
      id: a.id,
      createdAt: a.createdAt,
      action: a.action,
      outcome: a.outcome,
      actor: a.actor,
      customer: a.customer,
      documentName: (a.metadata as { displayName?: string } | null)?.displayName,
    });
    res.json({
      data: {
        activeCustomers: customers,
        activeUsers,
        documents: docs._count._all,
        storedBytes: Number(docs._sum.sizeBytes ?? 0),
        last24h: { uploads: uploads24h._count._all, bytes: Number(uploads24h._sum.sizeBytes ?? 0) },
        recentUploads: recentUploads.map((d) => ({
          id: d.id,
          displayName: d.displayName,
          sizeBytes: Number(d.sizeBytes),
          availableAt: d.availableAt,
          customer: d.customer,
          uploadedBy: d.uploadedBy,
        })),
        recentDownloads: recentDownloads.map(event),
        recentAdminEvents: recentAdmin.map(event),
      },
    });
  });

  r.get("/storage", async (_req, res) => {
    const [customers, grouped, daily] = await Promise.all([
      s.prisma.customer.findMany({
        select: {
          id: true,
          name: true,
          customerCode: true,
          status: true,
          storageQuotaBytes: true,
          storageConnector: { select: { provider: true, bucket: true, region: true, authType: true, status: true, lastVerifiedAt: true } },
        },
        orderBy: { name: "asc" },
      }),
      s.prisma.document.groupBy({ by: ["customerId", "status"], _count: { _all: true }, _sum: { sizeBytes: true } }),
      s.prisma.$queryRaw<{ day: Date; uploads: bigint; bytes: bigint | null }[]>`
        SELECT date_trunc('day', "availableAt") AS day, COUNT(*) AS uploads, SUM("sizeBytes") AS bytes
        FROM "Document"
        WHERE "availableAt" >= now() - interval '30 days' AND status IN ('AVAILABLE', 'DELETED', 'PURGED')
        GROUP BY 1 ORDER BY 1`,
    ]);
    res.json({
      data: {
        customers: customers.map(({ storageQuotaBytes, ...c }) => {
          const rows = grouped.filter((g) => g.customerId === c.id);
          return {
            ...c,
            storageQuotaBytes: storageQuotaBytes === null ? null : Number(storageQuotaBytes),
            byStatus: Object.fromEntries(rows.map((g) => [g.status, { count: g._count._all, bytes: Number(g._sum.sizeBytes ?? 0) }])),
          };
        }),
        dailyUploads: daily.map((d) => ({ day: d.day, uploads: Number(d.uploads), bytes: Number(d.bytes ?? 0) })),
      },
    });
  });

  return r;
}
