import { AuditAction } from "../modules/audit/audit.service.js";
import type { Services } from "../services.js";

export interface ReconcileReport {
  objectsScanned: number;
  /** Locations scanned (platform bucket and each customer connector). */
  targets: string[];
  /** Objects with no document record at all. */
  orphanObjects: string[];
  /** Objects whose document is PURGED or UPLOAD_FAILED (bytes that should be gone). */
  strayObjects: string[];
  /** Objects whose document says it is stored in a different location. Never deleted automatically. */
  misplacedObjects: string[];
  /** AVAILABLE documents whose object is missing from their storage location. */
  missingObjects: string[];
  /** Locations that could not be scanned (e.g. a customer revoked access). */
  unreachableTargets: { target: string; error: string }[];
  removed: number;
  markedMissing: number;
  fixApplied: boolean;
}

/** Objects younger than this may belong to an upload that is still in progress. */
const ORPHAN_GRACE_MS = 24 * 3600 * 1000;

/**
 * Compares every storage location with the document table.
 * Without `fix` it only reports. With `fix`:
 *   - orphan objects older than the grace period and stray objects are deleted;
 *   - AVAILABLE documents without an object are marked MISSING_OBJECT (hidden
 *     from customers, visible to Tekpro staff for re-upload or deletion).
 * Misplaced objects and unreachable locations are reported for manual review.
 * Every change is audited.
 */
export async function reconcileStorage(s: Services, opts: { fix: boolean }): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    objectsScanned: 0,
    targets: [],
    orphanObjects: [],
    strayObjects: [],
    misplacedObjects: [],
    missingObjects: [],
    unreachableTargets: [],
    removed: 0,
    markedMissing: 0,
    fixApplied: opts.fix,
  };

  for (const target of await s.storageResolver.allTargets()) {
    report.targets.push(target.label);
    const seen = new Set<string>();
    const deletable: string[] = [];
    try {
      let token: string | undefined;
      do {
        const page = await target.adapter.listObjects(target.prefix, token);
        token = page.nextToken;
        report.objectsScanned += page.objects.length;
        const keys = page.objects.map((o) => o.key);
        keys.forEach((k) => seen.add(k));
        const docs = await s.prisma.document.findMany({
          where: { objectKey: { in: keys } },
          select: { objectKey: true, status: true, storageConnectorId: true },
        });
        const byKey = new Map(docs.map((d) => [d.objectKey, d]));
        for (const obj of page.objects) {
          const doc = byKey.get(obj.key);
          const label = `${target.label}:${obj.key}`;
          if (!doc) {
            const old = !obj.lastModified || Date.now() - obj.lastModified.getTime() > ORPHAN_GRACE_MS;
            if (old) {
              report.orphanObjects.push(label);
              deletable.push(obj.key);
            }
          } else if (doc.storageConnectorId !== target.connectorId) {
            report.misplacedObjects.push(label);
          } else if (doc.status === "PURGED" || doc.status === "UPLOAD_FAILED") {
            report.strayObjects.push(label);
            deletable.push(obj.key);
          }
        }
      } while (token);
    } catch (err) {
      report.unreachableTargets.push({ target: target.label, error: (err as Error).message });
      continue;
    }

    const available = await s.prisma.document.findMany({
      where: { status: "AVAILABLE", storageConnectorId: target.connectorId },
      select: { id: true, objectKey: true, customerId: true },
    });
    const missing = available.filter((d) => !seen.has(d.objectKey));
    report.missingObjects.push(...missing.map((d) => d.id));

    if (!opts.fix) continue;
    for (const key of deletable) {
      try {
        await target.adapter.deleteObject(key);
        report.removed++;
        await s.audit.record({
          action: AuditAction.STORAGE_ORPHAN_REMOVED,
          resourceType: "StorageObject",
          metadata: { objectKey: key, location: target.label },
        });
      } catch (err) {
        s.logger.warn({ objectKey: key, err: (err as Error).message }, "Failed to remove orphan object");
      }
    }
    for (const d of missing) {
      // Re-check right before changing state, in case of a concurrent upload or listing lag.
      if (await target.adapter.headObject(d.objectKey)) continue;
      const changed = await s.prisma.document.updateMany({ where: { id: d.id, status: "AVAILABLE" }, data: { status: "MISSING_OBJECT" } });
      if (changed.count) {
        report.markedMissing++;
        await s.audit.record({
          action: AuditAction.DOCUMENT_OBJECT_MISSING,
          resourceType: "Document",
          resourceId: d.id,
          customerId: d.customerId,
          outcome: "FAILURE",
          metadata: { location: target.label },
        });
      }
    }
  }
  if (report.misplacedObjects.length) {
    await s.audit.record({
      action: AuditAction.STORAGE_MISPLACED_OBJECT,
      resourceType: "StorageObject",
      outcome: "FAILURE",
      metadata: { count: report.misplacedObjects.length, sample: report.misplacedObjects.slice(0, 20) },
    });
  }
  return report;
}
