import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";

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
});

export type PortalSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: PortalSettings = {
  staffAuditAccess: true,
  staffCanDeleteDocuments: true,
  staffCanDeleteFolders: true,
  customerAdminActivityAccess: true,
  customerUserActivityAccess: false,
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
