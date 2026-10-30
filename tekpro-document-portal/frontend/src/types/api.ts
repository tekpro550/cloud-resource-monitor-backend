export type Role = "SUPER_ADMIN" | "TEKPRO_USER" | "CUSTOMER_ADMIN" | "CUSTOMER_USER";
export type AccessLevel = "VIEW" | "DOWNLOAD" | "MANAGE";
export type FolderPermission = "NONE" | "VIEW" | "DOWNLOAD";
export type DocumentStatus = "PENDING_UPLOAD" | "AVAILABLE" | "UPLOAD_FAILED" | "DELETED" | "PURGED" | "MISSING_OBJECT";

export interface CustomerRef {
  id: string;
  name: string;
  customerCode: string;
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: "ACTIVE" | "INACTIVE";
  customerId: string | null;
  customer: CustomerRef | null;
  passwordSet: boolean;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface MePayload {
  user: User;
  csrfToken: string;
  features: { activityAccess: boolean };
}

export interface Customer extends CustomerRef {
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
  updatedAt: string;
  documentCount?: number;
  totalBytes?: number;
}

export interface Folder {
  id: string;
  customerId: string;
  parentFolderId: string | null;
  name: string;
  access: AccessLevel;
  documentCount?: number;
  hiddenFromCustomer?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FolderDetail extends Folder {
  breadcrumb: { id: string; name: string }[];
}

export interface DocumentItem {
  id: string;
  customerId: string;
  folderId: string;
  folderName?: string | null;
  displayName: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
  availableAt: string | null;
  canDownload?: boolean;
  uploadedBy?: { id: string; fullName: string } | null;
  deletedAt?: string | null;
  purgeAfter?: string | null;
}

export interface Paged<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  action: string;
  outcome: "SUCCESS" | "FAILURE" | "DENIED";
  resourceType: string;
  resourceId: string | null;
  customer: { id: string; name: string } | null;
  actor: { id: string; fullName: string; email?: string; role?: Role } | null;
  requestId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown> | null;
  documentName?: string;
}

export interface PortalSettings {
  staffAuditAccess: boolean;
  staffCanDeleteDocuments: boolean;
  staffCanDeleteFolders: boolean;
  customerAdminActivityAccess: boolean;
  customerUserActivityAccess: boolean;
}

export interface UploadInitiation {
  uploadId: string;
  documentId: string;
  mode: "SINGLE" | "MULTIPART";
  expiresAt: string;
  partSize?: number;
  partCount?: number;
  upload?: { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string };
}
