import { Router } from "express";
import { principal, requireRoles } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { AuditAction } from "../audit/audit.service.js";
import { badRequest } from "../../utils/errors.js";
import { operationalPatchSchema, settingsSchema } from "./settings.service.js";

/**
 * System settings (Super Admin only).
 *   GET   /settings              access flags, operational limits (with server defaults) and server environment
 *   PATCH /settings              access flags
 *   PATCH /settings/operational  upload/download/retention/sign-in limits; null resets a value to its default
 * Infrastructure (storage service, email delivery, background jobs) comes from the server environment.
 */
export function settingsRoutes(s: Services): Router {
  const r = Router();
  r.use(requireRoles(s, "SUPER_ADMIN"));

  const environment = () => ({
    storageDriver: s.storage.name,
    mailDriver: s.config.mail.driver,
    jobsEnabled: s.config.jobs.enabled,
  });
  const body = async () => ({ settings: await s.settings.get(), operational: s.operational.current(), environment: environment() });

  r.get("/", async (_req, res) => {
    res.json({ data: await body() });
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
    res.json({ data: { ...(await body()), settings: result.after } });
  });

  r.patch("/operational", async (req, res) => {
    const patch = operationalPatchSchema.parse(req.body);
    const p = principal(req);
    const result = await s.prisma.$transaction(async (tx) => {
      const r2 = await s.operational.update(patch, p.userId, tx);
      if (r2.error) throw badRequest(r2.error);
      const changed = (Object.keys(r2.after) as (keyof typeof r2.after)[]).filter(
        (k) => JSON.stringify(r2.before[k]) !== JSON.stringify(r2.after[k]),
      );
      await s.audit.fromRequest(
        req,
        {
          action: AuditAction.SETTINGS_CHANGED,
          resourceType: "SystemSetting",
          metadata: {
            scope: "operational",
            before: Object.fromEntries(changed.map((k) => [k, r2.before[k]])),
            after: Object.fromEntries(changed.map((k) => [k, r2.after[k]])),
          },
        },
        tx,
      );
      return r2;
    });
    s.operational.apply(result.after, patch);
    res.json({ data: await body() });
  });

  return r;
}
