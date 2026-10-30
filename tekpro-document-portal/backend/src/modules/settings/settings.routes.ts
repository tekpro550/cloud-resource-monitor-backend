import { Router } from "express";
import { principal, requireRoles } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { AuditAction } from "../audit/audit.service.js";
import { settingsSchema } from "./settings.service.js";

/** System settings (Super Admin only). Environment-level configuration is shown read-only. */
export function settingsRoutes(s: Services): Router {
  const r = Router();
  r.use(requireRoles(s, "SUPER_ADMIN"));

  const configSummary = () => ({
    uploadMaxFileSizeBytes: s.config.upload.maxFileSizeBytes,
    uploadMultipartThresholdBytes: s.config.upload.multipartThresholdBytes,
    uploadPartSizeBytes: s.config.upload.partSizeBytes,
    uploadAllowedExtensions: [...s.config.upload.allowedExtensions].sort(),
    uploadUrlTtlSeconds: s.config.upload.urlTtlSeconds,
    uploadSessionTtlSeconds: s.config.upload.sessionTtlSeconds,
    downloadUrlTtlSeconds: s.config.downloadUrlTtlSeconds,
    deletedDocumentRetentionDays: s.config.deletedDocumentRetentionDays,
    sessionTtlSeconds: s.config.session.ttlSeconds,
    sessionIdleTimeoutSeconds: s.config.session.idleTimeoutSeconds,
    storageDriver: s.storage.name,
    mailDriver: s.config.mail.driver,
    jobsEnabled: s.config.jobs.enabled,
  });

  r.get("/", async (_req, res) => {
    res.json({ data: { settings: await s.settings.get(), configuration: configSummary() } });
  });

  r.patch("/", async (req, res) => {
    const patch = settingsSchema.partial().strict().parse(req.body);
    const p = principal(req);
    const result = await s.prisma.$transaction(async (tx) => {
      const r2 = await s.settings.update(patch, p.userId, tx);
      await s.audit.fromRequest(
        req,
        { action: AuditAction.SETTINGS_CHANGED, resourceType: "SystemSetting", metadata: { before: r2.before, after: r2.after } },
        tx,
      );
      return r2;
    });
    res.json({ data: { settings: result.after, configuration: configSummary() } });
  });

  return r;
}
