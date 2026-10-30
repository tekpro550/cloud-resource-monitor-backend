const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return dateFmt.format(new Date(value));
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return dateTimeFmt.format(new Date(value));
}

export const ROLE_LABELS = {
  SUPER_ADMIN: "Tekpro Super Admin",
  TEKPRO_USER: "Tekpro User",
  CUSTOMER_ADMIN: "Customer Admin",
  CUSTOMER_USER: "Customer User",
} as const;

/** Human-readable labels for audit actions. */
export function describeAction(action: string): string {
  const map: Record<string, string> = {
    "auth.login.succeeded": "Signed in",
    "auth.login.failed": "Failed sign-in",
    "auth.logout": "Signed out",
    "document.download.link_issued": "Download link issued",
    "document.upload.completed": "Uploaded document",
    "document.upload.initiated": "Started upload",
    "document.upload.failed": "Upload failed",
    "document.deleted": "Deleted document",
    "document.renamed": "Renamed document",
    "document.moved": "Moved document",
    "folder.created": "Created folder",
    "folder.deleted": "Deleted folder",
    "user.created": "Created user",
    "user.deactivated": "Deactivated user",
    "user.role_changed": "Changed role",
    "customer.created": "Created customer",
    "assignment.created": "Assigned staff",
    "assignment.removed": "Removed staff assignment",
    "permission.changed": "Changed folder permission",
    "security.access_denied": "Access denied",
    "settings.changed": "Changed settings",
  };
  return map[action] ?? action;
}
