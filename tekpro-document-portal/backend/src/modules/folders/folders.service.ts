import type { Prisma, PrismaClient } from "@prisma/client";
import { badRequest } from "../../utils/errors.js";

type Db = Prisma.TransactionClient | PrismaClient;

export const MAX_FOLDER_DEPTH = 20;
export const MAX_RECURSIVE_DELETE_DOCUMENTS = 5000;

/**
 * Serialises structural folder changes for one customer. Moves and creations
 * take this row lock first so two concurrent moves cannot combine into a cycle.
 */
export async function lockCustomerTree(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerId}::uuid FOR UPDATE`;
}

/** Ids of the folder's live ancestors, nearest first. */
export async function ancestorIds(tx: Db, folderId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string; depth: number }[]>`
    WITH RECURSIVE chain AS (
      SELECT id, "parentFolderId", 0 AS depth FROM "Folder" WHERE id = ${folderId}::uuid
      UNION ALL
      SELECT f.id, f."parentFolderId", c.depth + 1 FROM "Folder" f JOIN chain c ON f.id = c."parentFolderId"
      WHERE c.depth < 100
    )
    SELECT id::text AS id, depth FROM chain WHERE depth > 0 ORDER BY depth`;
  return rows.map((r) => r.id);
}

/** Ids of the folder and all its live descendants. */
export async function subtreeIds(tx: Db, folderId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT id, 0 AS depth FROM "Folder" WHERE id = ${folderId}::uuid
      UNION ALL
      SELECT f.id, t.depth + 1 FROM "Folder" f JOIN tree t ON f."parentFolderId" = t.id
      WHERE f."deletedAt" IS NULL AND t.depth < 100
    )
    SELECT id::text AS id FROM tree`;
  return rows.map((r) => r.id);
}

/** Height of the subtree rooted at folderId (a leaf has height 1). */
export async function subtreeHeight(tx: Db, folderId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ h: number }[]>`
    WITH RECURSIVE tree AS (
      SELECT id, 1 AS depth FROM "Folder" WHERE id = ${folderId}::uuid
      UNION ALL
      SELECT f.id, t.depth + 1 FROM "Folder" f JOIN tree t ON f."parentFolderId" = t.id
      WHERE f."deletedAt" IS NULL AND t.depth < 100
    )
    SELECT MAX(depth)::int AS h FROM tree`;
  return rows[0]?.h ?? 1;
}

/**
 * Validates that `folderId` can be placed under `newParentId` (same customer,
 * live parent, no cycle, depth limit). Must run inside lockCustomerTree.
 */
export async function validateMove(
  tx: Prisma.TransactionClient,
  folder: { id: string; customerId: string },
  newParentId: string | null,
): Promise<void> {
  if (newParentId === null) return;
  if (newParentId === folder.id) throw badRequest("A folder cannot be moved into itself");
  const parent = await tx.folder.findUnique({ where: { id: newParentId } });
  if (!parent || parent.deletedAt || parent.customerId !== folder.customerId) {
    throw badRequest("The destination folder does not exist in this customer");
  }
  const parentAncestors = await ancestorIds(tx, newParentId);
  if (parentAncestors.includes(folder.id)) throw badRequest("A folder cannot be moved into one of its own subfolders");
  const height = await subtreeHeight(tx, folder.id);
  if (parentAncestors.length + 1 + height > MAX_FOLDER_DEPTH) {
    throw badRequest(`Folders cannot be nested more than ${MAX_FOLDER_DEPTH} levels deep`);
  }
}
