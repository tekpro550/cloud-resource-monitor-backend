import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";

/**
 * Administrator-configurable policy flags. Stored in SystemSetting; defaults
 * apply until the Super Admin changes a value.
 */
export const settingsSchema = z.object({
  /** Designated Tekpro Users may view audit records of their assigned customers. */
  staffAuditAccess: z.boolean(),
  /** Designated Tekpro Users may delete documents in assigned customers. */
  staffCanDeleteDocuments: z.boolean(),
  /** Designated Tekpro Users may delete folders in assigned customers. */
  staffCanDeleteFolders: z.boolean(),
  /** Customer Admins may view download/login activity of their organisation. */
  customerAdminActivityAccess: z.boolean(),
  /** Customer Users may view their own download/login activity. */
  customerUserActivityAccess: z.boolean(),
  /** Customer Admins may create and delete their organisation's own storage bucket. */
  customerAdminCanManageStorage: z.boolean(),
});

export type PortalSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: PortalSettings = {
  staffAuditAccess: true,
  staffCanDeleteDocuments: true,
  staffCanDeleteFolders: true,
  customerAdminActivityAccess: true,
  customerUserActivityAccess: false,
  customerAdminCanManageStorage: true,
};

const KEY_PREFIX = "setting:";

export class SettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async get(): Promise<PortalSettings> {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { startsWith: KEY_PREFIX } } });
    const out: PortalSettings = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      const name = row.key.slice(KEY_PREFIX.length) as keyof PortalSettings;
      if (name in DEFAULT_SETTINGS && typeof row.value === "boolean") out[name] = row.value;
    }
    return out;
  }

  async update(
    patch: Partial<PortalSettings>,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ before: PortalSettings; after: PortalSettings }> {
    const before = await this.get();
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      await tx.systemSetting.upsert({
        where: { key: KEY_PREFIX + name },
        create: { key: KEY_PREFIX + name, value, updatedByUserId: userId },
        update: { value, updatedByUserId: userId },
      });
    }
    return { before, after: { ...before, ...patch } as PortalSettings };
  }
}

// ------------------------------------------------------------ operational settings

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Executable and script types that can never be allowed (their content is not signature-checked). */
export const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "com", "scr", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "hta", "jar", "sh", "bash", "app", "dmg", "pkg", "apk", "html", "htm", "svg", "php", "py", "lnk", "reg",
]);

/**
 * Upload, download, retention and sign-in limits. Defaults come from the server
 * environment; a Super Admin can override them at runtime (stored in SystemSetting).
 * Pre-signed URL lifetimes are capped at 15 minutes so they never outlive the
 * temporary credentials used for customer-owned storage.
 */
export const operationalSchema = z.object({
  uploadMaxFileSizeBytes: z.number().int().min(MiB).max(5 * 1024 * GiB),
  uploadMultipartThresholdBytes: z.number().int().min(5 * MiB).max(5 * GiB),
  uploadPartSizeBytes: z.number().int().min(5 * MiB).max(5 * GiB),
  uploadAllowedExtensions: z
    .array(z.string().trim().toLowerCase().regex(/^[a-z0-9]{1,10}$/, "Extensions are 1-10 letters or digits, without the dot"))
    .min(1)
    .max(200)
    .refine((list) => !list.some((e) => BLOCKED_EXTENSIONS.has(e)), {
      message: `Executable and script types cannot be allowed (${[...BLOCKED_EXTENSIONS].join(", ")})`,
    }),
  uploadUrlTtlSeconds: z.number().int().min(60).max(900),
  uploadSessionTtlSeconds: z.number().int().min(300).max(7 * 86400),
  downloadUrlTtlSeconds: z.number().int().min(30).max(900),
  deletedDocumentRetentionDays: z.number().int().min(0).max(3650),
  sessionTtlSeconds: z.number().int().min(300).max(30 * 86400),
  sessionIdleTimeoutSeconds: z.number().int().min(60).max(86400),
});

export type OperationalSettings = z.infer<typeof operationalSchema>;
export type OperationalName = keyof OperationalSettings;

/** Patch body: a value sets an override, null resets to the server default. */
export const operationalPatchSchema = z
  .object(Object.fromEntries(Object.entries(operationalSchema.shape).map(([k, v]) => [k, v.nullable().optional()])) as {
    [K in OperationalName]: z.ZodOptional<z.ZodNullable<(typeof operationalSchema.shape)[K]>>;
  })
  .strict();

const OP_PREFIX = "config:";

function readOperational(c: AppConfig): OperationalSettings {
  return {
    uploadMaxFileSizeBytes: c.upload.maxFileSizeBytes,
    uploadMultipartThresholdBytes: c.upload.multipartThresholdBytes,
    uploadPartSizeBytes: c.upload.partSizeBytes,
    uploadAllowedExtensions: [...c.upload.allowedExtensions].sort(),
    uploadUrlTtlSeconds: c.upload.urlTtlSeconds,
    uploadSessionTtlSeconds: c.upload.sessionTtlSeconds,
    downloadUrlTtlSeconds: c.downloadUrlTtlSeconds,
    deletedDocumentRetentionDays: c.deletedDocumentRetentionDays,
    sessionTtlSeconds: c.session.ttlSeconds,
    sessionIdleTimeoutSeconds: c.session.idleTimeoutSeconds,
  };
}

function writeOperational(c: AppConfig, v: OperationalSettings): void {
  c.upload.maxFileSizeBytes = v.uploadMaxFileSizeBytes;
  c.upload.multipartThresholdBytes = v.uploadMultipartThresholdBytes;
  c.upload.partSizeBytes = v.uploadPartSizeBytes;
  c.upload.allowedExtensions = new Set(v.uploadAllowedExtensions);
  c.upload.urlTtlSeconds = v.uploadUrlTtlSeconds;
  c.upload.sessionTtlSeconds = v.uploadSessionTtlSeconds;
  c.downloadUrlTtlSeconds = v.downloadUrlTtlSeconds;
  c.deletedDocumentRetentionDays = v.deletedDocumentRetentionDays;
  c.session.ttlSeconds = v.sessionTtlSeconds;
  c.session.idleTimeoutSeconds = v.sessionIdleTimeoutSeconds;
}

function crossCheck(v: OperationalSettings): string | null {
  if (v.sessionIdleTimeoutSeconds > v.sessionTtlSeconds) return "The idle sign-out time cannot be longer than the maximum session length";
  if (v.uploadPartSizeBytes * 10_000 < v.uploadMaxFileSizeBytes) {
    return "Upload part size is too small for the maximum file size (at most 10,000 parts per file)";
  }
  return null;
}

/**
 * Applies Super Admin overrides to the live configuration object, which the
 * request handlers read on every request. Every instance refreshes periodically
 * (OperationalSettingsService.startRefresh), so a change reaches all replicas.
 */
export class OperationalSettingsService {
  readonly defaults: OperationalSettings;
  private overridden = new Set<OperationalName>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
  ) {
    this.defaults = readOperational(config);
  }

  current(): { values: OperationalSettings; defaults: OperationalSettings; overridden: OperationalName[] } {
    return { values: readOperational(this.config), defaults: this.defaults, overridden: [...this.overridden].sort() };
  }

  /** Loads overrides from the database and applies them. Invalid stored values are ignored. */
  async refresh(): Promise<void> {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { startsWith: OP_PREFIX } } });
    const merged: Record<string, unknown> = { ...this.defaults };
    const overridden = new Set<OperationalName>();
    for (const row of rows) {
      const name = row.key.slice(OP_PREFIX.length) as OperationalName;
      const field = operationalSchema.shape[name];
      if (!field) continue;
      const parsed = field.safeParse(row.value);
      if (parsed.success) {
        merged[name] = parsed.data;
        overridden.add(name);
      }
    }
    const values = operationalSchema.safeParse(merged);
    if (!values.success || crossCheck(values.data)) return;
    writeOperational(this.config, values.data);
    this.overridden = overridden;
  }

  startRefresh(intervalMs = 30_000): () => void {
    const timer = setInterval(() => void this.refresh().catch(() => undefined), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Validates and stores a patch; call apply() with `after` once the transaction commits. */
  async update(
    patch: z.infer<typeof operationalPatchSchema>,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ before: OperationalSettings; after: OperationalSettings; error?: string }> {
    const before = readOperational(this.config);
    const after: OperationalSettings = { ...before };
    for (const [name, value] of Object.entries(patch) as [OperationalName, unknown][]) {
      if (value === undefined) continue;
      (after as Record<string, unknown>)[name] = value === null ? this.defaults[name] : value;
    }
    const error = crossCheck(after);
    if (error) return { before, after, error };
    for (const [name, value] of Object.entries(patch) as [OperationalName, unknown][]) {
      if (value === undefined) continue;
      if (value === null) {
        await tx.systemSetting.deleteMany({ where: { key: OP_PREFIX + name } });
      } else {
        await tx.systemSetting.upsert({
          where: { key: OP_PREFIX + name },
          create: { key: OP_PREFIX + name, value: value as Prisma.InputJsonValue, updatedByUserId: userId },
          update: { value: value as Prisma.InputJsonValue, updatedByUserId: userId },
        });
      }
    }
    return { before, after };
  }

  apply(values: OperationalSettings, patch: z.infer<typeof operationalPatchSchema>): void {
    writeOperational(this.config, values);
    for (const [name, value] of Object.entries(patch) as [OperationalName, unknown][]) {
      if (value === null) this.overridden.delete(name);
      else if (value !== undefined) this.overridden.add(name);
    }
  }
}
