import { randomUUID } from "node:crypto";
import type { Document, UploadSession } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { principal } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { objectKeyFor, StorageError } from "../../storage/storage.js";
import { AppError, badRequest, invalidState } from "../../utils/errors.js";
import { fileExtension, validateDisplayName } from "../../utils/filenames.js";
import { serializeDocument } from "../../utils/serialize.js";
import type { Principal } from "../../types/context.js";
import { AuditAction } from "../audit/audit.service.js";
import { AccessDeniedError } from "../permissions/accessPolicy.js";
import { assertWithinQuota } from "../storageUsage/storageUsage.js";
import { checkContent, mimeTypeForExtension, SNIFF_BYTES } from "./fileTypes.js";

const MIN_PART_SIZE = 5 * 1024 * 1024; // S3 minimum for every part except the last
const MAX_PARTS = 10_000; // S3 maximum part count
const MiB = 1024 * 1024;

const customerParam = z.object({ customerId: z.uuid() });
const uploadParam = z.object({ uploadId: z.uuid() });
const initiateSchema = z.object({
  folderId: z.uuid(),
  filename: z.string().max(300),
  sizeBytes: z.number().int().min(0),
  description: z.string().trim().max(1000).optional(),
});
const partsSchema = z.object({ partNumbers: z.array(z.number().int().min(1).max(MAX_PARTS)).min(1).max(100) });
const completeSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(MAX_PARTS), etag: z.string().min(1).max(200) }))
    .max(MAX_PARTS)
    .optional(),
});

export function choosePartSize(sizeBytes: number, configured: number): number {
  const needed = Math.ceil(sizeBytes / MAX_PARTS);
  const size = Math.max(configured, MIN_PART_SIZE, needed);
  return Math.ceil(size / MiB) * MiB;
}

/**
 * Upload workflow (see docs/ARCHITECTURE.md):
 *   initiate  -> Document(PENDING_UPLOAD) + UploadSession(INITIATED) + pre-signed request(s)
 *   browser   -> uploads bytes directly to object storage
 *   complete  -> server verifies the object (exists, exact size, content signature)
 *                and only then marks the document AVAILABLE
 * Completion is idempotent and retry-safe; abandoned sessions are expired by the
 * cleanup job, which also aborts multipart uploads and removes partial objects.
 */
export function uploadsRoutes(s: Services): { customerScoped: Router; uploadScoped: Router } {
  const customerScoped = Router({ mergeParams: true });
  const uploadScoped = Router();

  customerScoped.post("/initiate", async (req, res) => {
    const { customerId } = customerParam.parse(req.params);
    const body = initiateSchema.parse(req.body);
    const p = principal(req);
    await s.policy.requireCustomerManage(p, customerId);
    const folder = await s.policy.requireFolder(p, body.folderId, "MANAGE");
    if (folder.customerId !== customerId) throw badRequest("The folder belongs to a different customer");

    const displayName = validateDisplayName(body.filename, "File name");
    const ext = fileExtension(displayName);
    if (!ext || !s.config.upload.allowedExtensions.has(ext)) {
      throw new AppError(415, "FILE_TYPE_NOT_ALLOWED", `Files of type ${ext ? `.${ext}` : "(no extension)"} are not allowed`, {
        allowedExtensions: [...s.config.upload.allowedExtensions].sort(),
      });
    }
    if (body.sizeBytes > s.config.upload.maxFileSizeBytes) {
      throw new AppError(413, "FILE_TOO_LARGE", "The file exceeds the maximum allowed size", {
        maxFileSizeBytes: s.config.upload.maxFileSizeBytes,
      });
    }

    const documentId = randomUUID();
    const objectKey = objectKeyFor(customerId, documentId);
    const mimeType = mimeTypeForExtension(ext);
    const multipart = body.sizeBytes > s.config.upload.multipartThresholdBytes;
    const partSize = multipart ? choosePartSize(body.sizeBytes, s.config.upload.partSizeBytes) : null;
    const partCount = partSize ? Math.ceil(body.sizeBytes / partSize) : null;
    const expiresAt = new Date(Date.now() + s.config.upload.sessionTtlSeconds * 1000);

    // The customer's own storage connector when configured (must be ACTIVE), else platform storage.
    const target = await s.storageResolver.uploadTarget(customerId);
    const session = await s.prisma.$transaction(async (tx) => {
      await assertWithinQuota(tx, customerId, body.sizeBytes);
      await tx.document.create({
        data: {
          id: documentId,
          customerId,
          folderId: folder.id,
          displayName,
          extension: ext,
          objectKey,
          mimeType,
          sizeBytes: BigInt(body.sizeBytes),
          description: body.description,
          status: "PENDING_UPLOAD",
          uploadedByUserId: p.userId,
          storageConnectorId: target.connectorId,
        },
      });
      const us = await tx.uploadSession.create({
        data: {
          documentId,
          customerId,
          folderId: folder.id,
          createdByUserId: p.userId,
          mode: multipart ? "MULTIPART" : "SINGLE",
          expectedSize: BigInt(body.sizeBytes),
          partSize: partSize ? BigInt(partSize) : null,
          partCount,
          expiresAt,
        },
      });
      await s.audit.fromRequest(
        req,
        {
          action: AuditAction.UPLOAD_INITIATED,
          resourceType: "Document",
          resourceId: documentId,
          customerId,
          metadata: { displayName, sizeBytes: body.sizeBytes, folderId: folder.id, mode: us.mode, storage: target.connectorId ? "customer" : "platform" },
        },
        tx,
      );
      return us;
    });

    try {
      if (multipart) {
        const storageUploadId = await target.adapter.createMultipartUpload(objectKey, { contentType: mimeType });
        await s.prisma.uploadSession.update({ where: { id: session.id }, data: { storageUploadId } });
        res.status(201).json({
          data: {
            uploadId: session.id,
            documentId,
            mode: "MULTIPART",
            partSize,
            partCount,
            expiresAt,
          },
        });
      } else {
        const put = await target.adapter.presignPut(objectKey, {
          contentType: mimeType,
          contentLength: body.sizeBytes,
          expiresInSeconds: s.config.upload.urlTtlSeconds,
        });
        res.status(201).json({
          data: {
            uploadId: session.id,
            documentId,
            mode: "SINGLE",
            expiresAt,
            upload: { url: put.url, method: put.method, headers: put.headers, expiresAt: put.expiresAt },
          },
        });
      }
    } catch (err) {
      await markFailed(s, req, session, `storage error during initiation: ${err instanceof Error ? err.message : "unknown"}`);
      throw err;
    }
  });

  const loadOwnSession = async (p: Principal, uploadId: string) => {
    const session = await s.prisma.uploadSession.findUnique({ where: { id: uploadId }, include: { document: true } });
    if (!session) throw new AccessDeniedError(404, "Upload not found", { resourceType: "Upload", resourceId: uploadId, reason: "missing" });
    // Assignment is re-checked on every step, so removing an assignment stops in-flight uploads.
    const canManage = await s.policy.canAccessCustomer(p, session.customerId);
    if (!canManage || (p.role !== "SUPER_ADMIN" && p.role !== "TEKPRO_USER")) {
      throw new AccessDeniedError(404, "Upload not found", {
        resourceType: "Upload",
        resourceId: uploadId,
        customerId: session.customerId,
        reason: "customer not manageable",
      });
    }
    if (p.role !== "SUPER_ADMIN" && session.createdByUserId !== p.userId) {
      throw new AccessDeniedError(404, "Upload not found", {
        resourceType: "Upload",
        resourceId: uploadId,
        customerId: session.customerId,
        reason: "upload started by another user",
      });
    }
    return session;
  };

  uploadScoped.post("/:uploadId/parts", async (req, res) => {
    const { uploadId } = uploadParam.parse(req.params);
    const { partNumbers } = partsSchema.parse(req.body);
    const session = await loadOwnSession(principal(req), uploadId);
    if (session.mode !== "MULTIPART" || !session.storageUploadId) throw invalidState("This upload is not a multipart upload");
    if (session.status !== "INITIATED") throw invalidState(`Upload is ${session.status.toLowerCase()}`);
    if (session.expiresAt.getTime() <= Date.now()) throw new AppError(410, "UPLOAD_EXPIRED", "The upload session has expired");
    const invalid = partNumbers.filter((n) => n > (session.partCount ?? 0));
    if (invalid.length) throw badRequest("Part number out of range", { invalid });
    const storage = await s.storageResolver.forDocument(session.document);
    const ttl = Math.min(s.config.upload.urlTtlSeconds, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    const urls = await Promise.all(
      [...new Set(partNumbers)].map(async (partNumber) => {
        const r = await storage.presignUploadPart(session.document.objectKey, session.storageUploadId!, partNumber, Math.max(60, ttl));
        return { partNumber, url: r.url, method: r.method, expiresAt: r.expiresAt };
      }),
    );
    res.json({ data: { parts: urls } });
  });

  uploadScoped.post("/:uploadId/complete", async (req, res) => {
    const { uploadId } = uploadParam.parse(req.params);
    const body = completeSchema.parse(req.body ?? {});
    const p = principal(req);
    let session = await loadOwnSession(p, uploadId);

    if (session.status === "COMPLETED") {
      // Idempotent retry of a completion that already succeeded.
      return res.json({ data: serializeDocument(session.document, p.role) });
    }
    if (session.status !== "INITIATED") throw invalidState(`Upload is ${session.status.toLowerCase()}`);
    if (session.expiresAt.getTime() <= Date.now()) {
      await expireSession(s, session, req);
      throw new AppError(410, "UPLOAD_EXPIRED", "The upload session has expired. Please upload the file again.");
    }
    // Re-validate the destination folder: it may have been deleted or moved out of reach.
    await s.policy.requireFolder(p, session.folderId, "MANAGE");

    // Claim the session so concurrent completion requests cannot both run.
    const claimed = await s.prisma.uploadSession.updateMany({ where: { id: uploadId, status: "INITIATED" }, data: { status: "COMPLETING" } });
    if (claimed.count !== 1) throw invalidState("Upload completion is already in progress");
    session = { ...session, status: "COMPLETING" };
    const release = () => s.prisma.uploadSession.update({ where: { id: uploadId }, data: { status: "INITIATED" } });
    const key = session.document.objectKey;
    const storage = await s.storageResolver.forDocument(session.document);

    try {
      if (session.mode === "MULTIPART") {
        const parts = body.parts ?? [];
        const expected = session.partCount ?? 0;
        const numbers = new Set(parts.map((x) => x.partNumber));
        if (parts.length !== expected || numbers.size !== expected || [...numbers].some((n) => n < 1 || n > expected)) {
          await release();
          throw badRequest(`All ${expected} parts must be listed exactly once to complete the upload`);
        }
        try {
          await storage.completeMultipartUpload(key, session.storageUploadId!, parts);
        } catch (err) {
          // NOT_FOUND can mean an earlier attempt already completed it; verify below.
          if (!(err instanceof StorageError && err.kind === "NOT_FOUND")) {
            await release();
            if (err instanceof StorageError && err.kind === "INCOMPLETE_UPLOAD") {
              throw new AppError(400, "UPLOAD_VERIFICATION_FAILED", "Some parts are missing or do not match. Retry the failed parts and complete again.");
            }
            throw err;
          }
        }
      }

      const head = await storage.headObject(key);
      if (!head) {
        await release();
        throw new AppError(409, "UPLOAD_VERIFICATION_FAILED", "The uploaded file was not found in storage. Upload the file and try again.");
      }
      if (head.sizeBytes !== Number(session.expectedSize)) {
        await rejectUpload(s, req, session, `size mismatch: expected ${session.expectedSize}, stored ${head.sizeBytes}`);
        throw new AppError(422, "UPLOAD_VERIFICATION_FAILED", "The stored file size does not match the declared size. The upload was rejected.");
      }
      const prefix = await storage.readObjectPrefix(key, SNIFF_BYTES);
      const check = await checkContent(prefix, session.document.extension, s.config.upload.allowedExtensions);
      if (!check.ok) {
        await rejectUpload(s, req, session, `content check failed: ${check.reason}`);
        throw new AppError(422, "FILE_TYPE_NOT_ALLOWED", `The file content does not match its type (${check.reason}). The upload was rejected.`);
      }

      const document = await s.prisma.$transaction(async (tx) => {
        const d = await tx.document.update({
          where: { id: session.documentId },
          data: { status: "AVAILABLE", sizeBytes: BigInt(head.sizeBytes), storageEtag: head.etag ?? null, availableAt: new Date() },
          include: { uploadedBy: { select: { id: true, fullName: true } } },
        });
        await tx.uploadSession.update({ where: { id: uploadId }, data: { status: "COMPLETED", completedAt: new Date() } });
        await s.audit.fromRequest(
          req,
          {
            action: AuditAction.UPLOAD_COMPLETED,
            resourceType: "Document",
            resourceId: d.id,
            customerId: d.customerId,
            metadata: { displayName: d.displayName, sizeBytes: head.sizeBytes, mode: session.mode, detectedType: check.detectedExtension },
          },
          tx,
        );
        return d;
      });
      res.json({ data: serializeDocument(document, p.role) });
    } catch (err) {
      // Expected outcomes (AppError) already set the session state; anything else
      // (storage outage, database error) returns the session to INITIATED so the
      // client can retry completion.
      if (!(err instanceof AppError)) await release().catch(() => undefined);
      throw err;
    }
  });

  uploadScoped.post("/:uploadId/abort", async (req, res) => {
    const { uploadId } = uploadParam.parse(req.params);
    const session = await loadOwnSession(principal(req), uploadId);
    if (session.status === "ABORTED") return res.status(204).end();
    if (session.status !== "INITIATED") throw invalidState(`Upload is ${session.status.toLowerCase()}`);
    await cleanupStorage(s, session, session.document);
    await s.prisma.$transaction(async (tx) => {
      await tx.uploadSession.update({ where: { id: uploadId }, data: { status: "ABORTED", failureReason: "aborted by user" } });
      await tx.document.update({ where: { id: session.documentId }, data: { status: "UPLOAD_FAILED" } });
      await s.audit.fromRequest(
        req,
        { action: AuditAction.UPLOAD_ABORTED, resourceType: "Document", resourceId: session.documentId, customerId: session.customerId },
        tx,
      );
    });
    res.status(204).end();
  });

  return { customerScoped, uploadScoped };
}

/** Removes any partial or rejected bytes for an upload session. */
export async function cleanupStorage(s: Services, session: UploadSession, document: Pick<Document, "objectKey" | "storageConnectorId">): Promise<void> {
  const storage = await s.storageResolver.forDocument(document);
  if (session.mode === "MULTIPART" && session.storageUploadId) {
    await storage.abortMultipartUpload(document.objectKey, session.storageUploadId);
  }
  await storage.deleteObject(document.objectKey);
}

async function markFailed(s: Services, req: Request | null, session: UploadSession, reason: string) {
  await s.prisma.$transaction(async (tx) => {
    await tx.uploadSession.update({ where: { id: session.id }, data: { status: "FAILED", failureReason: reason.slice(0, 500) } });
    await tx.document.update({ where: { id: session.documentId }, data: { status: "UPLOAD_FAILED" } });
    const event = {
      action: AuditAction.UPLOAD_FAILED,
      resourceType: "Document",
      resourceId: session.documentId,
      customerId: session.customerId,
      outcome: "FAILURE" as const,
      metadata: { reason },
    };
    if (req) await s.audit.fromRequest(req, event, tx);
    else await s.audit.record(event, tx);
  });
}

async function rejectUpload(s: Services, req: Request, session: UploadSession & { document: Document }, reason: string) {
  try {
    await (await s.storageResolver.forDocument(session.document)).deleteObject(session.document.objectKey);
  } catch (err) {
    // The reconciliation job removes objects whose document is UPLOAD_FAILED.
    s.logger.warn({ err: (err as Error).message, documentId: session.documentId }, "Could not delete rejected upload object");
  }
  await markFailed(s, req, session, reason);
}

export async function expireSession(s: Services, session: UploadSession & { document: Document }, req: Request | null) {
  try {
    await cleanupStorage(s, session, session.document);
  } catch (err) {
    s.logger.warn({ err: (err as Error).message, uploadId: session.id }, "Storage cleanup for expired upload failed; will retry");
    return false;
  }
  await s.prisma.$transaction(async (tx) => {
    const updated = await tx.uploadSession.updateMany({
      where: { id: session.id, status: { in: ["INITIATED", "COMPLETING"] } },
      data: { status: "EXPIRED", failureReason: "upload session expired" },
    });
    if (!updated.count) return;
    await tx.document.update({ where: { id: session.documentId }, data: { status: "UPLOAD_FAILED" } });
    const event = {
      action: AuditAction.UPLOAD_EXPIRED,
      resourceType: "Document",
      resourceId: session.documentId,
      customerId: session.customerId,
      outcome: "FAILURE" as const,
    };
    if (req) await s.audit.fromRequest(req, event, tx);
    else await s.audit.record(event, tx);
  });
  return true;
}
