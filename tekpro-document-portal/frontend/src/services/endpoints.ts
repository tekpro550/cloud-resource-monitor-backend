import type {
  AuditEntry,
  Customer,
  DocumentItem,
  Folder,
  FolderDetail,
  FolderPermission,
  MePayload,
  Paged,
  OperationalSettings,
  PortalSettings,
  SettingsPayload,
  StorageUsage,
  Role,
  StorageConnector,
  StorageConnectorView,
  ConnectorInput,
  VerificationResult,
  UploadInitiation,
  User,
} from "../types/api";
import { http, type Query } from "./api";

export const authApi = {
  me: () => http.get<MePayload>("/auth/me", undefined, { silentAuth: true }),
  login: (email: string, password: string) => http.post<MePayload>("/auth/login", { email, password }),
  logout: () => http.post<void>("/auth/logout"),
  forgotPassword: (email: string) => http.post<{ message: string }>("/auth/forgot-password", { email }),
  resetPassword: (token: string, newPassword: string) => http.post<{ message: string }>("/auth/reset-password", { token, newPassword }),
  changePassword: (currentPassword: string, newPassword: string) =>
    http.post<MePayload>("/auth/change-password", { currentPassword, newPassword }),
};

export const customersApi = {
  list: (q?: Query) => http.get<Paged<Customer>>("/customers", q),
  get: (id: string) => http.get<Customer>(`/customers/${id}`),
  create: (body: { name: string; customerCode: string }) => http.post<Customer>("/customers", body),
  update: (id: string, body: Partial<Pick<Customer, "name" | "status" | "storageQuotaBytes">>) => http.patch<Customer>(`/customers/${id}`, body),
  storageUsage: (id: string) => http.get<StorageUsage>(`/customers/${id}/storage-usage`),
  stats: (id: string) =>
    http.get<{
      folders: number;
      activeUsers: number;
      documentsByStatus: Record<string, { count: number; bytes: number }>;
      last24h: { uploads: number; bytes: number };
    }>(`/customers/${id}/stats`),
  users: (id: string) => http.get<User[]>(`/customers/${id}/users`),
  assignments: (id: string) =>
    http.get<{ id: string; user: User; assignedBy: { id: string; fullName: string } | null; createdAt: string }[]>(`/customers/${id}/assignments`),
  assign: (id: string, userId: string) => http.post(`/customers/${id}/assignments`, { userId }),
  unassign: (id: string, userId: string) => http.delete(`/customers/${id}/assignments/${userId}`),
};

export interface InviteResult {
  emailSent: boolean;
  link?: string;
}

export const usersApi = {
  list: (q?: Query) => http.get<Paged<User>>("/users", q),
  get: (id: string) =>
    http.get<{
      user: User;
      assignments: { id: string; customer: Customer; createdAt: string }[];
      folderPermissions: { folderId: string; folderName: string; permission: FolderPermission; updatedAt: string }[];
    }>(`/users/${id}`),
  create: (body: { email: string; fullName: string; role: Role; customerId?: string | null }) =>
    http.post<{ user: User; invite: InviteResult }>("/users", body),
  update: (id: string, body: { fullName?: string; email?: string; role?: Role }) => http.patch<User>(`/users/${id}`, body),
  deactivate: (id: string) => http.post<User>(`/users/${id}/deactivate`),
  activate: (id: string) => http.post<User>(`/users/${id}/activate`),
  passwordReset: (id: string) => http.post<InviteResult>(`/users/${id}/password-reset`),
  setFolderPermission: (id: string, folderId: string, permission: FolderPermission) =>
    http.put(`/users/${id}/folder-permissions/${folderId}`, { permission }),
  removeFolderPermission: (id: string, folderId: string) => http.delete(`/users/${id}/folder-permissions/${folderId}`),
};

export const foldersApi = {
  list: (customerId: string) => http.get<Folder[]>(`/customers/${customerId}/folders`),
  get: (id: string) => http.get<FolderDetail>(`/folders/${id}`),
  create: (customerId: string, name: string, parentFolderId: string | null) =>
    http.post<Folder>(`/customers/${customerId}/folders`, { name, parentFolderId }),
  update: (id: string, body: { name?: string; parentFolderId?: string | null; hiddenFromCustomer?: boolean }) =>
    http.patch<Folder>(`/folders/${id}`, body),
  remove: (id: string, body?: { recursive: boolean; confirmName?: string }) =>
    http.delete<{ subfoldersDeleted: number; documentsDeleted: number }>(`/folders/${id}`, body ?? {}),
  permissions: (id: string) =>
    http.get<{ user: { id: string; fullName: string; email: string; status: string }; permission: FolderPermission }[]>(`/folders/${id}/permissions`),
};

export const documentsApi = {
  list: (customerId: string, q?: Query) => http.get<Paged<DocumentItem>>(`/customers/${customerId}/documents`, q),
  get: (id: string) => http.get<DocumentItem>(`/documents/${id}`),
  download: (id: string) => http.get<{ url: string; expiresAt: string; filename: string; sizeBytes: number }>(`/documents/${id}/download`),
  update: (id: string, body: { displayName?: string; folderId?: string; description?: string | null }) =>
    http.patch<DocumentItem>(`/documents/${id}`, body),
  remove: (id: string) => http.delete<{ id: string; status: string; purgeAfter: string }>(`/documents/${id}`),
  restore: (id: string, folderId?: string) => http.post<DocumentItem>(`/documents/${id}/restore`, folderId ? { folderId } : {}),
};

export const uploadsApi = {
  initiate: (customerId: string, body: { folderId: string; filename: string; sizeBytes: number }) =>
    http.post<UploadInitiation>(`/customers/${customerId}/uploads/initiate`, body),
  partUrls: (uploadId: string, partNumbers: number[]) =>
    http.post<{ parts: { partNumber: number; url: string; method: "PUT"; expiresAt: string }[] }>(`/uploads/${uploadId}/parts`, { partNumbers }),
  complete: (uploadId: string, parts?: { partNumber: number; etag: string }[]) => http.post<DocumentItem>(`/uploads/${uploadId}/complete`, parts ? { parts } : {}),
  abort: (uploadId: string) => http.post<void>(`/uploads/${uploadId}/abort`),
};

export const auditApi = {
  list: (q?: Query) => http.get<Paged<AuditEntry>>("/audit-logs", q),
};

export const settingsApi = {
  get: () => http.get<SettingsPayload>("/settings"),
  update: (patch: Partial<PortalSettings>) => http.patch<SettingsPayload>("/settings", patch),
  /** A number sets a value; null resets it to the server default. */
  updateOperational: (patch: { [K in keyof OperationalSettings]?: OperationalSettings[K] | null }) => http.patch<SettingsPayload>("/settings/operational", patch),
};

export interface OverviewStats {
  activeCustomers: number;
  activeUsers: number;
  documents: number;
  storedBytes: number;
  last24h: { uploads: number; bytes: number };
  recentUploads: { id: string; displayName: string; sizeBytes: number; availableAt: string; customer: { id: string; name: string }; uploadedBy: { fullName: string } | null }[];
  recentDownloads: { id: string; createdAt: string; actor: { fullName: string } | null; customer: { name: string } | null; documentName?: string }[];
  recentAdminEvents: { id: string; createdAt: string; action: string; outcome: string; actor: { fullName: string } | null; customer: { name: string } | null }[];
}

export const statsApi = {
  overview: () => http.get<OverviewStats>("/stats/overview"),
  storage: () =>
    http.get<{
      customers: {
        id: string;
        name: string;
        customerCode: string;
        status: string;
        byStatus: Record<string, { count: number; bytes: number }>;
        storageQuotaBytes: number | null;
        storageConnector: Pick<StorageConnector, "provider" | "bucket" | "region" | "authType" | "status" | "lastVerifiedAt"> | null;
      }[];
      dailyUploads: { day: string; uploads: number; bytes: number }[];
    }>("/stats/storage"),
};

export const storageConnectorApi = {
  get: (customerId: string) => http.get<StorageConnectorView>(`/customers/${customerId}/storage-connector`),
  save: (customerId: string, body: ConnectorInput) => http.put<StorageConnector>(`/customers/${customerId}/storage-connector`, body),
  verify: (customerId: string) =>
    http.post<{ result: VerificationResult; connector: StorageConnector }>(`/customers/${customerId}/storage-connector/verify`),
  disable: (customerId: string) => http.post<StorageConnector>(`/customers/${customerId}/storage-connector/disable`),
  enable: (customerId: string) => http.post<StorageConnector>(`/customers/${customerId}/storage-connector/enable`),
  remove: (customerId: string) => http.delete<void>(`/customers/${customerId}/storage-connector`),
  createBucket: (customerId: string, body: { bucket: string; region: string }) =>
    http.post<{ result: VerificationResult; connector: { bucket: string; region: string; status: string } }>(`/customers/${customerId}/storage-connector/bucket`, body),
  deleteBucket: (customerId: string, confirmBucket: string) =>
    http.delete<{ deleted: string; storage: string }>(`/customers/${customerId}/storage-connector/bucket`, { confirmBucket }),
};
