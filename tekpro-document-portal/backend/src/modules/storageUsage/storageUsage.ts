import type { Prisma, PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { principal, requireRoles } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { AppError } from "../../utils/errors.js";
import { managedBucketPrefix } from "../storageConnectors/policies.js";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Documents that occupy storage: uploads in progress (space reserved for the
 * announced size), available documents, and deleted documents still kept for the
 * retention period.
 */
const OCCUPYING = ["PENDING_UPLOAD", "AVAILABLE", "DELETED"] as const;

export interface StorageUsage {
  usedBytes: number;
  documents: { count: number; bytes: number };
  deletedPendingPurge: { count: number; bytes: number };
  uploading: { count: number; bytes: number };
}

export async function storageUsage(db: Db, customerId: string): Promise<StorageUsage> {
  const rows = await db.document.groupBy({
    by: ["status"],
    where: { customerId, status: { in: [...OCCUPYING] } },
    _count: { _all: true },
    _sum: { sizeBytes: true },
  });
  const pick = (status: string) => {
    const r = rows.find((x) => x.status === status);
    return { count: r?._count._all ?? 0, bytes: Number(r?._sum.sizeBytes ?? 0) };
  };
  const documents = pick("AVAILABLE");
  const deletedPendingPurge = pick("DELETED");
  const uploading = pick("PENDING_UPLOAD");
  return { usedBytes: documents.bytes + deletedPendingPurge.bytes + uploading.bytes, documents, deletedPendingPurge, uploading };
}

/**
 * Refuses an upload that would take the customer over its storage limit. Must run
 * inside the transaction that creates the pending document: the customer row is
 * locked so concurrent uploads cannot both pass the check.
 */
export async function assertWithinQuota(tx: Prisma.TransactionClient, customerId: string, additionalBytes: number): Promise<void> {
  const [row] = await tx.$queryRaw<{ storageQuotaBytes: bigint | null }[]>`
    SELECT "storageQuotaBytes" FROM "Customer" WHERE id = ${customerId}::uuid FOR UPDATE`;
  if (!row || row.storageQuotaBytes === null) return;
  const quota = Number(row.storageQuotaBytes);
  const { usedBytes } = await storageUsage(tx, customerId);
  if (usedBytes + additionalBytes > quota) {
    throw new AppError(
      413,
      "STORAGE_QUOTA_EXCEEDED",
      "This upload would exceed the customer's storage limit. Delete documents (deleted documents count until they are purged) or ask a Super Admin to raise the limit.",
      { quotaBytes: quota, usedBytes, availableBytes: Math.max(0, quota - usedBytes), requestedBytes: additionalBytes },
    );
  }
}

/**
 *   GET /customers/:customerId/storage-usage
 * Super Admin, assigned Tekpro User and the customer's Customer Admin.
 * Tekpro's own platform bucket name is never shown to customer roles. `bucketManagement`
 * tells the UI whether this user may create/delete the customer's own bucket.
 */
export function storageUsageRoutes(s: Services): Router {
  const r = Router({ mergeParams: true });
  r.get("/", requireRoles(s, "SUPER_ADMIN", "TEKPRO_USER", "CUSTOMER_ADMIN"), async (req, res) => {
    const { customerId } = z.object({ customerId: z.uuid() }).parse(req.params);
    const p = principal(req);
    const customer = await s.policy.requireCustomerAccess(p, customerId);
    const [usage, connector, settings] = await Promise.all([
      storageUsage(s.prisma, customerId),
      s.prisma.storageConnector.findUnique({ where: { customerId }, select: { id: true, provider: true, bucket: true, region: true, status: true } }),
      s.settings.get(),
    ]);
    const canManage = p.role === "SUPER_ADMIN" || (p.role === "CUSTOMER_ADMIN" && settings.customerAdminCanManageStorage);
    const documentsInBucket = connector
      ? await s.prisma.document.count({ where: { storageConnectorId: connector.id, status: { not: "PURGED" } } })
      : 0;
    const quotaBytes = customer.storageQuotaBytes === null ? null : Number(customer.storageQuotaBytes);
    res.json({
      data: {
        ...usage,
        quotaBytes,
        availableBytes: quotaBytes === null ? null : Math.max(0, quotaBytes - usage.usedBytes),
        location: connector
          ? { mode: "CUSTOMER", provider: connector.provider, bucket: connector.bucket, region: connector.region, status: connector.status }
          : { mode: "PLATFORM" },
        bucketManagement: {
          allowed: canManage,
          // Buckets are created through a connection to the customer's AWS account (set up by a Super Admin).
          available: !!connector && connector.provider !== "LIGHTSAIL",
          bucketPrefix: managedBucketPrefix(customer.customerCode),
          documentsInBucket,
        },
      },
    });
  });
  return r;
}
