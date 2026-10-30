import type { DocumentStatus, Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { principal } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { badRequest, invalidState } from "../../utils/errors.js";
import { attachmentContentDisposition, validateDisplayName, fileExtension } from "../../utils/filenames.js";
import { escapeLike, pageResult, paginationSchema, toSkipTake } from "../../utils/pagination.js";
import { serializeDocument } from "../../utils/serialize.js";
import { AuditAction } from "../audit/audit.service.js";
import { hasLevel, isPlatformRole } from "../permissions/accessPolicy.js";
import { subtreeIds } from "../folders/folders.service.js";

const customerParam = z.object({ customerId: z.uuid() });
const docParam = z.object({ documentId: z.uuid() });

/** File-type filter categories exposed to the UI. */
export const TYPE_CATEGORIES: Record<string, string[]> = {
  pdf: ["pdf"],
  document: ["doc", "docx", "odt", "rtf", "txt"],
  spreadsheet: ["xls", "xlsx", "xlsm", "ods", "csv"],
  presentation: ["ppt", "pptx", "odp"],
  image: ["png", "jpg", "jpeg", "gif", "tif", "tiff", "webp"],
  archive: ["zip", "7z", "gz", "tar"],
  drawing: ["dwg", "dxf"],
  email: ["eml", "msg"],
};

const listQuery = paginationSchema.extend({
  folderId: z.uuid().optional(),
  recursive: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(200).optional(),
  type: z.string().trim().max(30).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(["name", "size", "date"]).default("date"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: z.enum(["AVAILABLE", "PENDING_UPLOAD", "UPLOAD_FAILED", "DELETED", "MISSING_OBJECT"]).default("AVAILABLE"),
});

const updateSchema = z
  .object({
    displayName: z.string().max(300).optional(),
    folderId: z.uuid().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

const restoreSchema = z.object({ folderId: z.uuid().optional() }).default({});

export function documentsRoutes(s: Services): { customerScoped: Router; documentScoped: Router } {
  const customerScoped = Router({ mergeParams: true });
  const documentScoped = Router();

  /**
   * Paginated, permission-filtered document search. The folder filter is
   * intersected with the folders the principal can see, so search results can
   * never include metadata from inaccessible folders.
   */
  customerScoped.get("/", async (req, res) => {
    const { customerId } = customerParam.parse(req.params);
    const q = listQuery.parse(req.query);
    const p = principal(req);
    await s.policy.requireCustomerAccess(p, customerId);
    if (q.status !== "AVAILABLE" && !isPlatformRole(p.role)) {
      // Customer roles only ever see available documents.
      q.status = "AVAILABLE";
    }
    const access = await s.policy.folderAccessMap(p, customerId);
    let folderIds: string[];
    if (q.folderId) {
      const folder = await s.policy.requireFolder(p, q.folderId, "VIEW");
      if (folder.customerId !== customerId) throw badRequest("The folder belongs to a different customer");
      folderIds = q.recursive === "true" ? (await subtreeIds(s.prisma, q.folderId)).filter((id) => access.has(id)) : [q.folderId];
    } else {
      folderIds = [...access.keys()];
    }

    const extensions = q.type ? (TYPE_CATEGORIES[q.type] ?? [q.type.toLowerCase().replace(/^\./, "")]) : undefined;
    const where: Prisma.DocumentWhereInput = {
      customerId,
      status: q.status as DocumentStatus,
      // Deleted documents may sit in deleted folders; Tekpro staff can still list them.
      ...(q.status === "DELETED" && !q.folderId ? {} : { folderId: { in: folderIds } }),
      ...(q.q ? { displayName: { contains: escapeLike(q.q), mode: "insensitive" } } : {}),
      ...(extensions ? { extension: { in: extensions } } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const orderField = q.sort === "name" ? "displayName" : q.sort === "size" ? "sizeBytes" : "createdAt";
    const [items, total] = await Promise.all([
      s.prisma.document.findMany({
        where,
        include: { uploadedBy: { select: { id: true, fullName: true } } },
        orderBy: [{ [orderField]: q.order }, { id: "asc" }],
        ...toSkipTake(q),
      }),
      s.prisma.document.count({ where }),
    ]);
    const folderNames = new Map(
      (await s.prisma.folder.findMany({ where: { id: { in: [...new Set(items.map((d) => d.folderId))] } }, select: { id: true, name: true } })).map(
        (f) => [f.id, f.name],
      ),
    );
    res.json({
      data: pageResult(
        items.map((d) => ({
          ...serializeDocument(d, p.role),
          folderName: folderNames.get(d.folderId) ?? null,
          canDownload: d.status === "AVAILABLE" && hasLevel(access.get(d.folderId), "DOWNLOAD"),
        })),
        total,
        q,
      ),
    });
  });

  documentScoped.get("/:documentId", async (req, res) => {
    const { documentId } = docParam.parse(req.params);
    const p = principal(req);
    const doc = await s.policy.requireDocument(p, documentId, "VIEW");
    const full = await s.prisma.document.findUniqueOrThrow({
      where: { id: doc.id },
      include: { uploadedBy: { select: { id: true, fullName: true } }, folder: { select: { id: true, name: true } } },
    });
    res.json({
      data: {
        ...serializeDocument(full, p.role),
        folderName: full.folder.name,
        canDownload: full.status === "AVAILABLE" && hasLevel(doc.access, "DOWNLOAD"),
      },
    });
  });

  /**
   * Issues a short-lived pre-signed download URL after the full authorisation
   * chain (customer -> folder permission -> document state). This records that a
   * download link was issued; it does not prove that the download completed.
   */
  documentScoped.get("/:documentId/download", async (req, res) => {
    const { documentId } = docParam.parse(req.params);
    const p = principal(req);
    const doc = await s.policy.requireDocument(p, documentId, "DOWNLOAD");
    if (doc.status !== "AVAILABLE") throw invalidState("This document is not available for download");
    const ttl = s.config.downloadUrlTtlSeconds;
    const signed = await s.storage.presignGet(doc.objectKey, {
      expiresInSeconds: ttl,
      contentDisposition: attachmentContentDisposition(doc.displayName),
      // Always served as a download; never rendered inline by the storage origin.
      contentType: "application/octet-stream",
    });
    await s.audit.fromRequest(req, {
      action: AuditAction.DOWNLOAD_LINK_ISSUED,
      resourceType: "Document",
      resourceId: doc.id,
      customerId: doc.customerId,
      metadata: { displayName: doc.displayName, sizeBytes: Number(doc.sizeBytes), ttlSeconds: ttl },
    });
    res.set("Cache-Control", "no-store");
    res.json({ data: { url: signed.url, expiresAt: signed.expiresAt, filename: doc.displayName, sizeBytes: Number(doc.sizeBytes) } });
  });

  documentScoped.patch("/:documentId", async (req, res) => {
    const { documentId } = docParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const p = principal(req);
    const doc = await s.policy.requireDocument(p, documentId, "MANAGE");
    if (doc.status !== "AVAILABLE") throw invalidState("Only available documents can be changed");

    let displayName: string | undefined;
    if (body.displayName !== undefined) {
      displayName = validateDisplayName(body.displayName, "File name");
      // The extension drives the served content type and was verified at upload.
      if (fileExtension(displayName) !== doc.extension) throw badRequest(`The file extension must remain .${doc.extension}`);
    }
    if (body.folderId && body.folderId !== doc.folderId) {
      const dest = await s.policy.requireFolder(p, body.folderId, "MANAGE");
      if (dest.customerId !== doc.customerId) throw badRequest("Documents cannot be moved to another customer");
    }

    // Renames and moves only change metadata; the object key is immutable, so no
    // storage copy is needed and there is no storage/database consistency risk.
    const updated = await s.prisma.$transaction(async (tx) => {
      const d = await tx.document.update({
        where: { id: documentId },
        data: {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(body.folderId ? { folderId: body.folderId } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        },
        include: { uploadedBy: { select: { id: true, fullName: true } } },
      });
      const base = { resourceType: "Document", resourceId: documentId, customerId: doc.customerId };
      if (displayName !== undefined && displayName !== doc.displayName) {
        await s.audit.fromRequest(req, { ...base, action: AuditAction.DOCUMENT_RENAMED, metadata: { from: doc.displayName, to: displayName } }, tx);
      }
      if (body.folderId && body.folderId !== doc.folderId) {
        await s.audit.fromRequest(req, { ...base, action: AuditAction.DOCUMENT_MOVED, metadata: { from: doc.folderId, to: body.folderId } }, tx);
      }
      if (body.description !== undefined && body.description !== doc.description) {
        await s.audit.fromRequest(req, { ...base, action: AuditAction.DOCUMENT_UPDATED, metadata: { field: "description" } }, tx);
      }
      return d;
    });
    res.json({ data: serializeDocument(updated, p.role) });
  });

  /**
   * Deletion is a two-stage, recoverable workflow:
   *   1. DELETE marks the document DELETED (hidden from customers immediately)
   *      and schedules a purge after DELETED_DOCUMENT_RETENTION_DAYS.
   *   2. The purge job deletes the storage object and marks the record PURGED,
   *      retrying on storage failure.
   * With a retention of 0 days the purge is attempted immediately.
   */
  documentScoped.delete("/:documentId", async (req, res) => {
    const { documentId } = docParam.parse(req.params);
    const p = principal(req);
    const doc = await s.policy.requireDocument(p, documentId, "MANAGE");
    await s.policy.requireDeleteAllowed(p, "document", documentId, doc.customerId);
    if (!["AVAILABLE", "MISSING_OBJECT"].includes(doc.status)) throw invalidState("This document cannot be deleted in its current state");
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + s.config.deletedDocumentRetentionDays * 86400_000);
    await s.prisma.$transaction(async (tx) => {
      const changed = await tx.document.updateMany({
        where: { id: documentId, status: doc.status },
        data: { status: "DELETED", deletedAt: now, deletedByUserId: p.userId, purgeAfter },
      });
      if (!changed.count) throw invalidState("The document was modified concurrently; reload and try again");
      await s.audit.fromRequest(
        req,
        {
          action: AuditAction.DOCUMENT_DELETED,
          resourceType: "Document",
          resourceId: documentId,
          customerId: doc.customerId,
          metadata: { displayName: doc.displayName, purgeAfter },
        },
        tx,
      );
    });
    if (s.config.deletedDocumentRetentionDays === 0) {
      const { purgeDocument } = await import("../../jobs/purgeDeleted.js");
      await purgeDocument(s, documentId);
    }
    res.json({ data: { id: documentId, status: "DELETED", purgeAfter } });
  });

  documentScoped.post("/:documentId/restore", async (req, res) => {
    const { documentId } = docParam.parse(req.params);
    const body = restoreSchema.parse(req.body ?? {});
    const p = principal(req);
    const doc = await s.policy.requireDocument(p, documentId, "MANAGE");
    if (doc.status !== "DELETED") throw invalidState("Only deleted documents can be restored");
    const head = await s.storage.headObject(doc.objectKey);
    if (!head) throw invalidState("The stored file no longer exists and cannot be restored");
    let folderId = doc.folderId;
    const folder = await s.prisma.folder.findUnique({ where: { id: folderId } });
    if (body.folderId) {
      const dest = await s.policy.requireFolder(p, body.folderId, "MANAGE");
      if (dest.customerId !== doc.customerId) throw badRequest("Documents cannot be restored into another customer");
      folderId = dest.id;
    } else if (!folder || folder.deletedAt) {
      throw badRequest("The original folder was deleted; choose a destination folder");
    }
    const restored = await s.prisma.$transaction(async (tx) => {
      const d = await tx.document.update({
        where: { id: documentId },
        data: { status: "AVAILABLE", folderId, deletedAt: null, deletedByUserId: null, purgeAfter: null, purgeAttempts: 0 },
        include: { uploadedBy: { select: { id: true, fullName: true } } },
      });
      await s.audit.fromRequest(
        req,
        { action: AuditAction.DOCUMENT_RESTORED, resourceType: "Document", resourceId: documentId, customerId: doc.customerId, metadata: { folderId } },
        tx,
      );
      return d;
    });
    res.json({ data: serializeDocument(restored, p.role) });
  });

  return { customerScoped, documentScoped };
}
