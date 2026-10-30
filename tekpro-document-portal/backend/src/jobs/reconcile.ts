import { AuditAction } from "../modules/audit/audit.service.js";
import type { Services } from "../services.js";
import { CUSTOMER_OBJECT_PREFIX } from "../storage/storage.js";

export interface ReconcileReport {
  objectsScanned: number;
  /** Objects with no document record at all. */
  orphanObjects: string[];
  /** Objects whose document is PURGED or UPLOAD_FAILED (bytes that should be gone). */
  strayObjects: string[];
  /** AVAILABLE documents whose object is missing. */
  missingObjects: string[];
  removed: number;
  markedMissing: number;
  fixApplied: boolean;
}

/** Objects younger than this may belong to an upload that is still in progress. */
const ORPHAN_GRACE_MS = 24 * 3600 * 1000;

/**
 * Compares object storage with the document table.
 * Without `fix` it only reports. With `fix`:
 *   - orphan objects older than the grace period and stray objects are deleted;
 *   - AVAILABLE documents without an object are marked MISSING_OBJECT (hidden
 *     from customers, visible to Tekpro staff for re-upload or deletion).
 * Every change is audited.
 */
export async function reconcileStorage(s: Services, opts: { fix: boolean }): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    objectsScanned: 0,
    orphanObjects: [],
    strayObjects: [],
    missingObjects: [],
    removed: 0,
    markedMissing: 0,
    fixApplied: opts.fix,
  };
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = await s.storage.listObjects(CUSTOMER_OBJECT_PREFIX, token);
    token = page.nextToken;
    report.objectsScanned += page.objects.length;
    const keys = page.objects.map((o) => o.key);
    keys.forEach((k) => seen.add(k));
    const docs = await s.prisma.document.findMany({ where: { objectKey: { in: keys } }, select: { objectKey: true, status: true } });
    const byKey = new Map(docs.map((d) => [d.objectKey, d.status]));
    for (const obj of page.objects) {
      const status = byKey.get(obj.key);
      if (!status) {
        const old = !obj.lastModified || Date.now() - obj.lastModified.getTime() > ORPHAN_GRACE_MS;
        if (old) report.orphanObjects.push(obj.key);
      } else if (status === "PURGED" || status === "UPLOAD_FAILED") {
        report.strayObjects.push(obj.key);
      }
    }
  } while (token);

  const available = await s.prisma.document.findMany({
    where: { status: "AVAILABLE" },
    select: { id: true, objectKey: true, customerId: true },
  });
  const missing = available.filter((d) => !seen.has(d.objectKey));
  report.missingObjects = missing.map((d) => d.id);

  if (opts.fix) {
    for (const key of [...report.orphanObjects, ...report.strayObjects]) {
      try {
        await s.storage.deleteObject(key);
        report.removed++;
        await s.audit.record({ action: AuditAction.STORAGE_ORPHAN_REMOVED, resourceType: "StorageObject", metadata: { objectKey: key } });
      } catch (err) {
        s.logger.warn({ objectKey: key, err: (err as Error).message }, "Failed to remove orphan object");
      }
    }
    for (const d of missing) {
      // Re-check right before changing state, in case of a concurrent upload or listing lag.
      if (await s.storage.headObject(d.objectKey)) continue;
      const changed = await s.prisma.document.updateMany({ where: { id: d.id, status: "AVAILABLE" }, data: { status: "MISSING_OBJECT" } });
      if (changed.count) {
        report.markedMissing++;
        await s.audit.record({
          action: AuditAction.DOCUMENT_OBJECT_MISSING,
          resourceType: "Document",
          resourceId: d.id,
          customerId: d.customerId,
          outcome: "FAILURE",
        });
      }
    }
  }
  return report;
}
