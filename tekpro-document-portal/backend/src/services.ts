import { AuditService } from "./modules/audit/audit.service.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { AccessPolicy } from "./modules/permissions/accessPolicy.js";
import { OperationalSettingsService, SettingsService } from "./modules/settings/settings.service.js";
import { StorageResolver } from "./storage/resolver.js";
import type { AppContext } from "./types/context.js";

export interface Services extends AppContext {
  audit: AuditService;
  settings: SettingsService;
  operational: OperationalSettingsService;
  policy: AccessPolicy;
  auth: AuthService;
  storageResolver: StorageResolver;
}

export function createServices(ctx: AppContext): Services {
  const audit = new AuditService(ctx.prisma, ctx.logger);
  const settings = new SettingsService(ctx.prisma);
  const policy = new AccessPolicy(ctx.prisma, settings);
  const auth = new AuthService(ctx, audit);
  const storageResolver = new StorageResolver(ctx.prisma, ctx.config, ctx.storage, ctx.connectorAdapterFactory);
  const operational = new OperationalSettingsService(ctx.prisma, ctx.config);
  return { ...ctx, audit, settings, operational, policy, auth, storageResolver };
}
