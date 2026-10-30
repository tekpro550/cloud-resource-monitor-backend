import { AuditService } from "./modules/audit/audit.service.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { AccessPolicy } from "./modules/permissions/accessPolicy.js";
import { SettingsService } from "./modules/settings/settings.service.js";
import type { AppContext } from "./types/context.js";

export interface Services extends AppContext {
  audit: AuditService;
  settings: SettingsService;
  policy: AccessPolicy;
  auth: AuthService;
}

export function createServices(ctx: AppContext): Services {
  const audit = new AuditService(ctx.prisma, ctx.logger);
  const settings = new SettingsService(ctx.prisma);
  const policy = new AccessPolicy(ctx.prisma, settings);
  const auth = new AuthService(ctx, audit);
  return { ...ctx, audit, settings, policy, auth };
}
