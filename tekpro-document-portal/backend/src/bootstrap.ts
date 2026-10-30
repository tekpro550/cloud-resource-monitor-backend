import { PrismaClient } from "@prisma/client";
import { ConfigError, loadConfig, type AppConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { createMailer } from "./modules/mail/mailer.js";
import { createStorage } from "./storage/index.js";
import type { AppContext } from "./types/context.js";

/** Builds the production dependency graph from environment configuration. */
export function buildContext(config: AppConfig = loadConfigOrExit()): AppContext {
  const logger = createLogger(config.logLevel, config.env === "development" && process.stdout.isTTY);
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  return { config, prisma, storage: createStorage(config), mailer: createMailer(config.mail, logger), logger };
}

export function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
