import type { PrismaClient, Role } from "@prisma/client";
import type { Logger } from "pino";
import type { AppConfig } from "../config/env.js";
import type { Mailer } from "../modules/mail/mailer.js";
import type { ConnectorAdapterFactory } from "../storage/resolver.js";
import type { StorageAdapter } from "../storage/storage.js";
import type { FetchLike } from "../modules/storageConnectors/verifier.js";

/** Dependencies shared by every module. Created once in createApp and injectable for tests. */
export interface AppContext {
  config: AppConfig;
  prisma: PrismaClient;
  /** Platform (Tekpro) storage. Customer connectors are resolved through StorageResolver. */
  storage: StorageAdapter;
  mailer: Mailer;
  logger: Logger;
  /** Test hooks: adapter factory for customer connectors and HTTP client for verification. */
  connectorAdapterFactory?: ConnectorAdapterFactory;
  fetch?: FetchLike;
}

/** The authenticated principal, loaded fresh from the database on every request. */
export interface Principal {
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  customerId: string | null;
  sessionId: string;
  csrfToken: string;
}

export interface RequestMeta {
  requestId: string;
  ipAddress?: string;
}
