import type { PrismaClient, Role } from "@prisma/client";
import type { Logger } from "pino";
import type { AppConfig } from "../config/env.js";
import type { Mailer } from "../modules/mail/mailer.js";
import type { StorageAdapter } from "../storage/storage.js";

/** Dependencies shared by every module. Created once in createApp and injectable for tests. */
export interface AppContext {
  config: AppConfig;
  prisma: PrismaClient;
  storage: StorageAdapter;
  mailer: Mailer;
  logger: Logger;
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
