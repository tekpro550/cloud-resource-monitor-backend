import { AuditAction } from "../modules/audit/audit.service.js";
import type { Services } from "../services.js";

/**
 * Deletes the storage object of a DELETED document and marks it PURGED.
 * Deleting a missing object succeeds in S3, so retries are safe. On failure the
 * document stays DELETED (hidden from customers) and the attempt is counted.
 */
export async function purgeDocument(s: Services, documentId: string): Promise<boolean> {
  const doc = await s.prisma.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.status !== "DELETED") return false;
  try {
    await (await s.storageResolver.forDocument(doc)).deleteObject(doc.objectKey);
  } catch (err) {
    await s.prisma.document.update({ where: { id: documentId }, data: { purgeAttempts: { increment: 1 } } });
    await s.audit.record({
      action: AuditAction.DOCUMENT_PURGE_FAILED,
      resourceType: "Document",
      resourceId: documentId,
      customerId: doc.customerId,
      outcome: "FAILURE",
      metadata: { error: (err as Error).message, attempts: doc.purgeAttempts + 1 },
    });
    s.logger.warn({ documentId, err: (err as Error).message }, "Purge of deleted document failed; will retry");
    return false;
  }
  await s.prisma.$transaction(async (tx) => {
    const changed = await tx.document.updateMany({ where: { id: documentId, status: "DELETED" }, data: { status: "PURGED", purgedAt: new Date() } });
    if (changed.count) {
      await s.audit.record(
        { action: AuditAction.DOCUMENT_PURGED, resourceType: "Document", resourceId: documentId, customerId: doc.customerId },
        tx,
      );
    }
  });
  return true;
}

export async function purgeDeletedDocuments(s: Services, batchSize = 200): Promise<{ purged: number; failed: number }> {
  const due = await s.prisma.document.findMany({
    where: { status: "DELETED", purgeAfter: { lte: new Date() } },
    select: { id: true },
    orderBy: { purgeAfter: "asc" },
    take: batchSize,
  });
  let purged = 0;
  let failed = 0;
  for (const d of due) {
    if (await purgeDocument(s, d.id)) purged++;
    else failed++;
  }
  return { purged, failed };
}
