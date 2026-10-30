import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { principal, requireRoles } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { badRequest, conflict } from "../../utils/errors.js";
import { validateDisplayName } from "../../utils/filenames.js";
import { serializeFolder } from "../../utils/serialize.js";
import { AuditAction } from "../audit/audit.service.js";
import {
  ancestorIds,
  lockCustomerTree,
  MAX_FOLDER_DEPTH,
  MAX_RECURSIVE_DELETE_DOCUMENTS,
  subtreeIds,
  validateMove,
} from "./folders.service.js";

const customerParam = z.object({ customerId: z.uuid() });
const folderParam = z.object({ folderId: z.uuid() });
const createSchema = z.object({ name: z.string().max(300), parentFolderId: z.uuid().nullish() });
const updateSchema = z
  .object({
    name: z.string().max(300).optional(),
    parentFolderId: z.uuid().nullable().optional(),
    hiddenFromCustomer: z.boolean().optional(),
  })
  .strict();
const deleteSchema = z.object({ recursive: z.boolean().default(false), confirmName: z.string().max(300).optional() }).default({ recursive: false });

const duplicateName = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
    ? conflict("A folder with this name already exists here", "DUPLICATE")
    : err;

export function foldersRoutes(s: Services): { customerScoped: Router; folderScoped: Router } {
  const customerScoped = Router({ mergeParams: true });
  const folderScoped = Router();

  /** Folder tree for a customer, filtered to what the principal may see. */
  customerScoped.get("/", async (req, res) => {
    const { customerId } = customerParam.parse(req.params);
    const p = principal(req);
    await s.policy.requireCustomerAccess(p, customerId);
    const access = await s.policy.folderAccessMap(p, customerId);
    const ids = [...access.keys()];
    const [folders, docCounts] = await Promise.all([
      s.prisma.folder.findMany({ where: { id: { in: ids } }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
      s.prisma.document.groupBy({
        by: ["folderId"],
        where: { customerId, folderId: { in: ids }, status: "AVAILABLE" },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(docCounts.map((d) => [d.folderId, d._count._all]));
    res.json({
      data: folders.map((f) => ({
        ...serializeFolder(f, p.role),
        // For customer roles, a folder whose parent is not visible is shown as a root.
        parentFolderId: f.parentFolderId && access.has(f.parentFolderId) ? f.parentFolderId : null,
        access: access.get(f.id),
        documentCount: counts.get(f.id) ?? 0,
      })),
    });
  });

  customerScoped.post("/", async (req, res) => {
    const { customerId } = customerParam.parse(req.params);
    const body = createSchema.parse(req.body);
    const p = principal(req);
    await s.policy.requireCustomerManage(p, customerId);
    const name = validateDisplayName(body.name, "Folder name");
    const parentId = body.parentFolderId ?? null;
    if (parentId) {
      const parent = await s.policy.requireFolder(p, parentId, "MANAGE");
      if (parent.customerId !== customerId) throw badRequest("The parent folder belongs to a different customer");
    }
    const folder = await s.prisma
      .$transaction(async (tx) => {
        await lockCustomerTree(tx, customerId);
        if (parentId) {
          const depth = (await ancestorIds(tx, parentId)).length + 2;
          if (depth > MAX_FOLDER_DEPTH) throw badRequest(`Folders cannot be nested more than ${MAX_FOLDER_DEPTH} levels deep`);
        }
        const f = await tx.folder.create({ data: { customerId, parentFolderId: parentId, name, createdByUserId: p.userId } });
        await s.audit.fromRequest(
          req,
          { action: AuditAction.FOLDER_CREATED, resourceType: "Folder", resourceId: f.id, customerId, metadata: { name, parentFolderId: parentId } },
          tx,
        );
        return f;
      })
      .catch((e) => {
        throw duplicateName(e);
      });
    res.status(201).json({ data: { ...serializeFolder(folder, p.role), access: "MANAGE", documentCount: 0 } });
  });

  folderScoped.get("/:folderId", async (req, res) => {
    const { folderId } = folderParam.parse(req.params);
    const p = principal(req);
    const folder = await s.policy.requireFolder(p, folderId, "VIEW");
    const access = await s.policy.folderAccessMap(p, folder.customerId);
    const chain = await ancestorIds(s.prisma, folderId);
    // Breadcrumb stops at the first ancestor the principal cannot see.
    const visible: string[] = [];
    for (const id of chain) {
      if (!access.has(id)) break;
      visible.push(id);
    }
    const ancestors = await s.prisma.folder.findMany({ where: { id: { in: visible } }, select: { id: true, name: true } });
    const byId = new Map(ancestors.map((a) => [a.id, a]));
    res.json({
      data: {
        ...serializeFolder(folder, p.role),
        parentFolderId: folder.parentFolderId && access.has(folder.parentFolderId) ? folder.parentFolderId : null,
        access: folder.access,
        breadcrumb: visible.reverse().map((id) => byId.get(id)!),
      },
    });
  });

  folderScoped.patch("/:folderId", async (req, res) => {
    const { folderId } = folderParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const p = principal(req);
    const folder = await s.policy.requireFolder(p, folderId, "MANAGE");
    if (body.hiddenFromCustomer !== undefined) s.policy.requireSuperAdmin(p);
    const name = body.name !== undefined ? validateDisplayName(body.name, "Folder name") : undefined;

    if (body.parentFolderId) {
      // The destination must also be manageable by the principal.
      const dest = await s.policy.requireFolder(p, body.parentFolderId, "MANAGE");
      if (dest.customerId !== folder.customerId) throw badRequest("Folders cannot be moved to another customer");
    }

    const updated = await s.prisma
      .$transaction(async (tx) => {
        await lockCustomerTree(tx, folder.customerId);
        const moving = body.parentFolderId !== undefined && body.parentFolderId !== folder.parentFolderId;
        if (moving) await validateMove(tx, folder, body.parentFolderId ?? null);
        const f = await tx.folder.update({
          where: { id: folderId },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(moving ? { parentFolderId: body.parentFolderId ?? null } : {}),
            ...(body.hiddenFromCustomer !== undefined ? { hiddenFromCustomer: body.hiddenFromCustomer } : {}),
          },
        });
        const base = { resourceType: "Folder", resourceId: folderId, customerId: folder.customerId };
        if (name !== undefined && name !== folder.name) {
          await s.audit.fromRequest(req, { ...base, action: AuditAction.FOLDER_RENAMED, metadata: { from: folder.name, to: name } }, tx);
        }
        if (moving) {
          await s.audit.fromRequest(
            req,
            { ...base, action: AuditAction.FOLDER_MOVED, metadata: { from: folder.parentFolderId, to: body.parentFolderId ?? null } },
            tx,
          );
        }
        if (body.hiddenFromCustomer !== undefined && body.hiddenFromCustomer !== folder.hiddenFromCustomer) {
          await s.audit.fromRequest(
            req,
            { ...base, action: AuditAction.FOLDER_VISIBILITY_CHANGED, metadata: { hiddenFromCustomer: body.hiddenFromCustomer } },
            tx,
          );
        }
        return f;
      })
      .catch((e) => {
        throw duplicateName(e);
      });
    res.json({ data: { ...serializeFolder(updated, p.role), access: "MANAGE" } });
  });

  /**
   * Folder deletion policy:
   *  - An empty folder is soft-deleted directly.
   *  - A non-empty folder requires { recursive: true, confirmName: <exact folder name> }.
   *    Its subfolders are soft-deleted and its live documents move to DELETED
   *    (recoverable until the retention period ends, then purged from storage).
   *  - Recursive deletion is refused above MAX_RECURSIVE_DELETE_DOCUMENTS documents.
   */
  folderScoped.delete("/:folderId", async (req, res) => {
    const { folderId } = folderParam.parse(req.params);
    const body = deleteSchema.parse(req.body ?? {});
    const p = principal(req);
    const folder = await s.policy.requireFolder(p, folderId, "MANAGE");
    await s.policy.requireDeleteAllowed(p, "folder", folderId, folder.customerId);

    const result = await s.prisma.$transaction(async (tx) => {
      await lockCustomerTree(tx, folder.customerId);
      const ids = await subtreeIds(tx, folderId);
      const liveDocs = await tx.document.count({
        where: { folderId: { in: ids }, status: { in: ["AVAILABLE", "PENDING_UPLOAD", "MISSING_OBJECT"] } },
      });
      const subfolders = ids.length - 1;
      if ((subfolders > 0 || liveDocs > 0) && !body.recursive) {
        throw conflict("The folder is not empty", "FOLDER_NOT_EMPTY", { subfolders, documents: liveDocs });
      }
      if (body.recursive && (subfolders > 0 || liveDocs > 0) && body.confirmName !== folder.name) {
        throw badRequest("Type the folder name exactly to confirm deletion of its contents", { subfolders, documents: liveDocs });
      }
      if (liveDocs > MAX_RECURSIVE_DELETE_DOCUMENTS) {
        throw conflict(`Folders containing more than ${MAX_RECURSIVE_DELETE_DOCUMENTS} documents must be emptied in smaller steps`, "FOLDER_NOT_EMPTY", {
          subfolders,
          documents: liveDocs,
        });
      }
      const now = new Date();
      const purgeAfter = new Date(now.getTime() + s.config.deletedDocumentRetentionDays * 86400_000);
      const docs = await tx.document.updateMany({
        where: { folderId: { in: ids }, status: { in: ["AVAILABLE", "MISSING_OBJECT"] } },
        data: { status: "DELETED", deletedAt: now, deletedByUserId: p.userId, purgeAfter },
      });
      // In-flight uploads into the subtree are expired so the cleanup job aborts them.
      await tx.uploadSession.updateMany({ where: { folderId: { in: ids }, status: "INITIATED" }, data: { expiresAt: now } });
      await tx.folder.updateMany({ where: { id: { in: ids }, deletedAt: null }, data: { deletedAt: now } });
      await s.audit.fromRequest(
        req,
        {
          action: AuditAction.FOLDER_DELETED,
          resourceType: "Folder",
          resourceId: folderId,
          customerId: folder.customerId,
          metadata: { name: folder.name, subfoldersDeleted: subfolders, documentsDeleted: docs.count, recursive: body.recursive },
        },
        tx,
      );
      return { subfoldersDeleted: subfolders, documentsDeleted: docs.count };
    });
    res.json({ data: result });
  });

  /** Customer-user grants on a folder (Super Admin only). */
  folderScoped.get("/:folderId/permissions", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { folderId } = folderParam.parse(req.params);
    const folder = await s.policy.requireFolder(principal(req), folderId, "MANAGE");
    const rows = await s.prisma.customerUserFolderPermission.findMany({
      where: { folderId: folder.id },
      include: { user: { select: { id: true, fullName: true, email: true, status: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({ data: rows.map((r) => ({ user: r.user, permission: r.permission, updatedAt: r.updatedAt })) });
  });

  return { customerScoped, folderScoped };
}

