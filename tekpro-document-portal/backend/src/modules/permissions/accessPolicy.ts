import type { Customer, Document, Folder, FolderPermissionLevel, PrismaClient, Role } from "@prisma/client";
import { AppError } from "../../utils/errors.js";
import type { Principal } from "../../types/context.js";
import type { SettingsService } from "../settings/settings.service.js";

/**
 * Central authorisation engine.
 *
 * Every route that touches customer data goes through this class. It never
 * trusts identifiers supplied by the client: each check loads the resource from
 * the database and derives the owning customer from the stored record.
 *
 * Access levels, from weakest to strongest:
 *   VIEW      see folder and document metadata
 *   DOWNLOAD  VIEW + obtain a short-lived download link
 *   MANAGE    DOWNLOAD + create/rename/move/delete folders and documents, upload
 *
 * Only SUPER_ADMIN and TEKPRO_USER (for assigned customers) can ever hold MANAGE.
 * Customer roles are capped at DOWNLOAD regardless of any folder grant.
 *
 * Folder permission inheritance for CUSTOMER_USER (documented in docs/SECURITY.md):
 *   - A grant on a folder applies to the folder and all its descendants.
 *   - The nearest explicit grant (walking up from the folder) wins, so a
 *     VIEW grant on a subfolder can restrict a DOWNLOAD grant on its parent.
 *   - An explicit NONE on a folder or ANY ancestor denies access to that whole
 *     subtree; a broader grant elsewhere never overrides it.
 *   - Folders marked hiddenFromCustomer (or under a hidden ancestor) are invisible
 *     to every customer role, including CUSTOMER_ADMIN.
 * CUSTOMER_ADMIN gets DOWNLOAD on every folder of its own customer that is not hidden.
 */

export type AccessLevel = "VIEW" | "DOWNLOAD" | "MANAGE";
const RANK: Record<AccessLevel, number> = { VIEW: 1, DOWNLOAD: 2, MANAGE: 3 };

export const PLATFORM_ROLES: Role[] = ["SUPER_ADMIN", "TEKPRO_USER"];
export const CUSTOMER_ROLES: Role[] = ["CUSTOMER_ADMIN", "CUSTOMER_USER"];

export const isPlatformRole = (role: Role) => PLATFORM_ROLES.includes(role);
export const isCustomerRole = (role: Role) => CUSTOMER_ROLES.includes(role);

export function hasLevel(actual: AccessLevel | undefined, needed: AccessLevel): boolean {
  return !!actual && RANK[actual] >= RANK[needed];
}

/**
 * Raised when a policy check fails. `status` is 404 when the caller is not
 * allowed to know the resource exists, otherwise 403. The error handler writes a
 * security audit record for every AccessDeniedError.
 */
export class AccessDeniedError extends AppError {
  constructor(
    status: 403 | 404,
    message: string,
    public readonly audit: { resourceType: string; resourceId?: string; customerId?: string | null; reason: string },
  ) {
    super(status, status === 404 ? "NOT_FOUND" : "FORBIDDEN", message);
  }
}

const hiddenResource = (resourceType: string, resourceId: string | undefined, reason: string, customerId?: string | null) =>
  new AccessDeniedError(404, `${resourceType} not found`, { resourceType, resourceId, reason, customerId });
const forbiddenAction = (resourceType: string, resourceId: string | undefined, reason: string, customerId?: string | null) =>
  new AccessDeniedError(403, "You do not have permission to perform this action", { resourceType, resourceId, reason, customerId });

type FolderNode = Pick<Folder, "id" | "parentFolderId" | "hiddenFromCustomer" | "name">;

export class AccessPolicy {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- roles

  requireRole(p: Principal, ...roles: Role[]): void {
    if (!roles.includes(p.role)) throw forbiddenAction("Endpoint", undefined, `role ${p.role} not in ${roles.join(",")}`);
  }

  requireSuperAdmin(p: Principal): void {
    this.requireRole(p, "SUPER_ADMIN");
  }

  // ------------------------------------------------------------ customers

  /** Customer ids the principal may access, or "ALL" for the Super Admin. */
  async accessibleCustomerIds(p: Principal): Promise<string[] | "ALL"> {
    switch (p.role) {
      case "SUPER_ADMIN":
        return "ALL";
      case "TEKPRO_USER": {
        const rows = await this.prisma.tekproUserCustomerAssignment.findMany({
          where: { userId: p.userId, customer: { status: "ACTIVE" } },
          select: { customerId: true },
        });
        return rows.map((r) => r.customerId);
      }
      default:
        return p.customerId ? [p.customerId] : [];
    }
  }

  async canAccessCustomer(p: Principal, customerId: string): Promise<boolean> {
    if (p.role === "SUPER_ADMIN") return true;
    if (p.role === "TEKPRO_USER") {
      const a = await this.prisma.tekproUserCustomerAssignment.findUnique({
        where: { userId_customerId: { userId: p.userId, customerId } },
        select: { customer: { select: { status: true } } },
      });
      return a?.customer.status === "ACTIVE";
    }
    return p.customerId === customerId;
  }

  /** Loads the customer if the principal may access it; otherwise behaves as "not found". */
  async requireCustomerAccess(p: Principal, customerId: string): Promise<Customer> {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer || !(await this.canAccessCustomer(p, customerId))) {
      throw hiddenResource("Customer", customerId, "customer not accessible", customer ? customerId : null);
    }
    if (customer.status !== "ACTIVE" && p.role !== "SUPER_ADMIN") {
      throw hiddenResource("Customer", customerId, "customer inactive", customerId);
    }
    return customer;
  }

  /** Content management (folders, uploads, document changes) for a customer. */
  async requireCustomerManage(p: Principal, customerId: string): Promise<Customer> {
    const customer = await this.requireCustomerAccess(p, customerId);
    if (!isPlatformRole(p.role)) throw forbiddenAction("Customer", customerId, "customer roles are download-only", customerId);
    return customer;
  }

  // -------------------------------------------------------------- folders

  /**
   * Effective access level for every live folder of a customer, for this
   * principal. Folders that are not in the map are invisible to the principal.
   * Callers must already have verified customer access.
   */
  async folderAccessMap(p: Principal, customerId: string): Promise<Map<string, AccessLevel>> {
    const folders = await this.prisma.folder.findMany({
      where: { customerId, deletedAt: null },
      select: { id: true, parentFolderId: true, hiddenFromCustomer: true, name: true },
    });
    if (isPlatformRole(p.role)) return new Map(folders.map((f) => [f.id, "MANAGE" as const]));
    if (p.customerId !== customerId) return new Map();

    let grants = new Map<string, FolderPermissionLevel>();
    if (p.role === "CUSTOMER_USER") {
      const rows = await this.prisma.customerUserFolderPermission.findMany({
        where: { userId: p.userId, customerId },
        select: { folderId: true, permission: true },
      });
      grants = new Map(rows.map((r) => [r.folderId, r.permission]));
    }
    return computeCustomerAccess(folders, p.role, grants);
  }

  async folderAccess(p: Principal, folder: Pick<Folder, "id" | "customerId">): Promise<AccessLevel | undefined> {
    if (!(await this.canAccessCustomer(p, folder.customerId))) return undefined;
    if (isPlatformRole(p.role)) return "MANAGE";
    return (await this.folderAccessMap(p, folder.customerId)).get(folder.id);
  }

  /** Loads a live folder and verifies the principal holds at least `needed`. */
  async requireFolder(p: Principal, folderId: string, needed: AccessLevel): Promise<Folder & { access: AccessLevel }> {
    const folder = await this.prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder || folder.deletedAt) throw hiddenResource("Folder", folderId, "folder missing or deleted");
    const customer = await this.prisma.customer.findUnique({ where: { id: folder.customerId }, select: { status: true } });
    if (customer?.status !== "ACTIVE" && p.role !== "SUPER_ADMIN") {
      throw hiddenResource("Folder", folderId, "customer inactive", folder.customerId);
    }
    const access = await this.folderAccess(p, folder);
    if (!access) throw hiddenResource("Folder", folderId, "folder not visible to principal", folder.customerId);
    if (!hasLevel(access, needed)) {
      throw forbiddenAction("Folder", folderId, `requires ${needed}, has ${access}`, folder.customerId);
    }
    return { ...folder, access };
  }

  // ------------------------------------------------------------ documents

  /**
   * Loads a document and verifies access through its folder and customer.
   * Customer roles can only ever see AVAILABLE documents; any other state is
   * reported as "not found" to them.
   */
  async requireDocument(p: Principal, documentId: string, needed: AccessLevel): Promise<Document & { access: AccessLevel }> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.status === "PURGED") throw hiddenResource("Document", documentId, "document missing");
    if (!(await this.canAccessCustomer(p, doc.customerId))) {
      throw hiddenResource("Document", documentId, "customer not accessible", doc.customerId);
    }
    if (isCustomerRole(p.role) && doc.status !== "AVAILABLE") {
      throw hiddenResource("Document", documentId, `document not available (${doc.status})`, doc.customerId);
    }
    const folder = await this.prisma.folder.findUnique({ where: { id: doc.folderId }, select: { id: true, customerId: true, deletedAt: true } });
    const access = folder && (folder.deletedAt === null || isPlatformRole(p.role)) ? await this.folderAccess(p, folder) : undefined;
    if (!access) throw hiddenResource("Document", documentId, "folder not visible to principal", doc.customerId);
    if (!hasLevel(access, needed)) {
      throw forbiddenAction("Document", documentId, `requires ${needed}, has ${access}`, doc.customerId);
    }
    return { ...doc, access };
  }

  /** Staff deletion can be switched off by the Super Admin. */
  async requireDeleteAllowed(p: Principal, kind: "document" | "folder", resourceId: string, customerId: string): Promise<void> {
    if (p.role === "SUPER_ADMIN") return;
    const s = await this.settings.get();
    const allowed = kind === "document" ? s.staffCanDeleteDocuments : s.staffCanDeleteFolders;
    if (p.role !== "TEKPRO_USER" || !allowed) {
      throw forbiddenAction(kind === "document" ? "Document" : "Folder", resourceId, `${kind} deletion not permitted for role`, customerId);
    }
  }
}

/** Pure inheritance computation; exported for unit testing. */
export function computeCustomerAccess(
  folders: FolderNode[],
  role: Role,
  grants: Map<string, FolderPermissionLevel>,
): Map<string, AccessLevel> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  type Resolved = { denied: boolean; level: AccessLevel | null };
  const memo = new Map<string, Resolved>();
  const visiting = new Set<string>();

  const resolve = (id: string): Resolved => {
    const cached = memo.get(id);
    if (cached) return cached;
    const f = byId.get(id);
    // Missing parent (deleted) or a corrupt cycle: deny rather than guess.
    if (!f || visiting.has(id)) return { denied: true, level: null };
    visiting.add(id);
    let result: Resolved;
    const parent: Resolved = f.parentFolderId ? resolve(f.parentFolderId) : { denied: false, level: null };
    if (f.hiddenFromCustomer || parent.denied) {
      result = { denied: true, level: null };
    } else if (role === "CUSTOMER_ADMIN") {
      result = { denied: false, level: "DOWNLOAD" };
    } else {
      const g = grants.get(id);
      if (g === "NONE") result = { denied: true, level: null };
      else if (g === "VIEW" || g === "DOWNLOAD") result = { denied: false, level: g };
      else result = parent;
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };

  const out = new Map<string, AccessLevel>();
  for (const f of folders) {
    const r = resolve(f.id);
    if (!r.denied && r.level) out.set(f.id, r.level);
  }
  return out;
}
