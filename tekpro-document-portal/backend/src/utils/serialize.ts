import type { Customer, Document, Folder, Role, User } from "@prisma/client";
import { isPlatformRole } from "../modules/permissions/accessPolicy.js";

/** Public view of a user. Never includes the password hash or lockout internals. */
export function serializeUser(u: User & { customer?: Pick<Customer, "id" | "name" | "customerCode"> | null }) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    status: u.status,
    customerId: u.customerId,
    customer: u.customer ? { id: u.customer.id, name: u.customer.name, customerCode: u.customer.customerCode } : null,
    passwordSet: !!u.passwordHash,
    locked: !!u.lockedUntil && u.lockedUntil.getTime() > Date.now(),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function serializeCustomer(c: Customer) {
  return {
    id: c.id,
    name: c.name,
    customerCode: c.customerCode,
    status: c.status,
    storageQuotaBytes: c.storageQuotaBytes === null ? null : Number(c.storageQuotaBytes),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function serializeFolder(f: Folder, viewerRole: Role) {
  return {
    id: f.id,
    customerId: f.customerId,
    parentFolderId: f.parentFolderId,
    name: f.name,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    // Visibility configuration is internal to Tekpro.
    ...(isPlatformRole(viewerRole) ? { hiddenFromCustomer: f.hiddenFromCustomer, createdByUserId: f.createdByUserId } : {}),
  };
}

/**
 * Document metadata. Customer roles receive only the approved subset; internal
 * fields (object key, ETag, uploader, lifecycle details) are Tekpro-only. The
 * object key is never returned to any client.
 */
export function serializeDocument(
  d: Document & { uploadedBy?: Pick<User, "id" | "fullName"> | null },
  viewerRole: Role,
) {
  const base = {
    id: d.id,
    customerId: d.customerId,
    folderId: d.folderId,
    displayName: d.displayName,
    extension: d.extension,
    mimeType: d.mimeType,
    sizeBytes: Number(d.sizeBytes),
    description: d.description,
    status: d.status,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    availableAt: d.availableAt,
  };
  if (!isPlatformRole(viewerRole)) return base;
  return {
    ...base,
    checksum: d.checksum,
    storageEtag: d.storageEtag,
    uploadedByUserId: d.uploadedByUserId,
    uploadedBy: d.uploadedBy ? { id: d.uploadedBy.id, fullName: d.uploadedBy.fullName } : null,
    deletedAt: d.deletedAt,
    purgeAfter: d.purgeAfter,
  };
}
