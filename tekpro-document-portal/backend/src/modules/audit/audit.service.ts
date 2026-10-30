import type { AuditOutcome, Prisma, PrismaClient } from "@prisma/client";
import type { Request } from "express";
import type { Logger } from "pino";

export const AuditAction = {
  LOGIN_SUCCEEDED: "auth.login.succeeded",
  LOGIN_FAILED: "auth.login.failed",
  LOGOUT: "auth.logout",
  PASSWORD_RESET_REQUESTED: "auth.password_reset.requested",
  PASSWORD_RESET_COMPLETED: "auth.password_reset.completed",
  PASSWORD_RESET_FAILED: "auth.password_reset.failed",
  PASSWORD_CHANGED: "auth.password.changed",
  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  USER_ROLE_CHANGED: "user.role_changed",
  USER_DEACTIVATED: "user.deactivated",
  USER_ACTIVATED: "user.activated",
  USER_PASSWORD_RESET_TRIGGERED: "user.password_reset_triggered",
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_UPDATED: "customer.updated",
  CUSTOMER_DEACTIVATED: "customer.deactivated",
  CUSTOMER_ACTIVATED: "customer.activated",
  ASSIGNMENT_CREATED: "assignment.created",
  ASSIGNMENT_REMOVED: "assignment.removed",
  FOLDER_CREATED: "folder.created",
  FOLDER_RENAMED: "folder.renamed",
  FOLDER_MOVED: "folder.moved",
  FOLDER_VISIBILITY_CHANGED: "folder.visibility_changed",
  FOLDER_DELETED: "folder.deleted",
  PERMISSION_CHANGED: "permission.changed",
  PERMISSION_REMOVED: "permission.removed",
  UPLOAD_INITIATED: "document.upload.initiated",
  UPLOAD_COMPLETED: "document.upload.completed",
  UPLOAD_FAILED: "document.upload.failed",
  UPLOAD_ABORTED: "document.upload.aborted",
  UPLOAD_EXPIRED: "document.upload.expired",
  DOWNLOAD_LINK_ISSUED: "document.download.link_issued",
  DOCUMENT_RENAMED: "document.renamed",
  DOCUMENT_MOVED: "document.moved",
  DOCUMENT_UPDATED: "document.updated",
  DOCUMENT_DELETED: "document.deleted",
  DOCUMENT_RESTORED: "document.restored",
  DOCUMENT_PURGED: "document.purged",
  DOCUMENT_PURGE_FAILED: "document.purge_failed",
  DOCUMENT_OBJECT_MISSING: "document.object_missing",
  STORAGE_ORPHAN_REMOVED: "storage.orphan_removed",
  ACCESS_DENIED: "security.access_denied",
  SETTINGS_CHANGED: "settings.changed",
  STORAGE_CONNECTOR_CREATED: "storage_connector.created",
  STORAGE_CONNECTOR_UPDATED: "storage_connector.updated",
  STORAGE_CONNECTOR_VERIFIED: "storage_connector.verified",
  STORAGE_CONNECTOR_VERIFICATION_FAILED: "storage_connector.verification_failed",
  STORAGE_CONNECTOR_DISABLED: "storage_connector.disabled",
  STORAGE_CONNECTOR_ENABLED: "storage_connector.enabled",
  STORAGE_CONNECTOR_DELETED: "storage_connector.deleted",
  STORAGE_BUCKET_CREATED: "storage_connector.bucket_created",
  STORAGE_BUCKET_DELETED: "storage_connector.bucket_deleted",
  STORAGE_QUOTA_CHANGED: "customer.storage_quota_changed",
  STORAGE_MISPLACED_OBJECT: "storage.misplaced_object",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

/** Actions a customer-side user may see in the activity view. */
export const CUSTOMER_VISIBLE_ACTIONS: AuditActionValue[] = [
  AuditAction.DOWNLOAD_LINK_ISSUED,
  AuditAction.LOGIN_SUCCEEDED,
  AuditAction.LOGOUT,
];

export interface AuditEvent {
  action: AuditActionValue;
  resourceType: string;
  resourceId?: string | null;
  outcome?: AuditOutcome;
  actorUserId?: string | null;
  customerId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY = /pass(word)?|token|secret|cookie|authorization|signature|credential|url/i;

/** Removes anything that looks like a credential before metadata is persisted. */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return depth > 4 ? "[truncated]" : value.slice(0, 50).map((v) => sanitizeMetadata(v, depth + 1));
  if (typeof value === "object") {
    if (depth > 4) return "[truncated]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Numbers and booleans (e.g. a URL lifetime in seconds) cannot carry a secret or a link.
      const harmless = typeof v === "number" || typeof v === "boolean";
      out[k] = SENSITIVE_KEY.test(k) && !harmless ? "[REDACTED]" : sanitizeMetadata(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  return value;
}

type Db = PrismaClient | Prisma.TransactionClient;

export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  /**
   * Writes an audit record. Pass a transaction client to make the record part of
   * the same database transaction as the change it describes. Outside a
   * transaction, failures are logged and swallowed so that auditing an already
   * completed action can never turn it into an error response.
   */
  async record(event: AuditEvent, db?: Db): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      outcome: event.outcome ?? "SUCCESS",
      actorUserId: event.actorUserId ?? null,
      customerId: event.customerId ?? null,
      requestId: event.requestId ?? null,
      ipAddress: event.ipAddress ?? null,
      metadata: event.metadata ? (sanitizeMetadata(event.metadata) as Prisma.InputJsonValue) : undefined,
    };
    if (db) {
      await db.auditLog.create({ data });
      return;
    }
    try {
      await this.prisma.auditLog.create({ data });
    } catch (err) {
      this.logger.error({ err, action: event.action, requestId: event.requestId }, "Failed to write audit record");
    }
  }

  /** Convenience wrapper that fills actor, request id and IP from the request. */
  fromRequest(req: Request, event: Omit<AuditEvent, "requestId" | "ipAddress">, db?: Db): Promise<void> {
    return this.record(
      {
        actorUserId: req.principal?.userId ?? null,
        ...event,
        requestId: String(req.id),
        ipAddress: req.ip ?? null,
      },
      db,
    );
  }
}
