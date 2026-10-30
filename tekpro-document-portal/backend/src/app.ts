import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { csrfProtection, loadSession, requireAuth } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { createRateLimiters } from "./middleware/rateLimit.js";
import { auditRoutes } from "./modules/audit/audit.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { customersRoutes } from "./modules/customers/customers.routes.js";
import { documentsRoutes } from "./modules/documents/documents.routes.js";
import { foldersRoutes } from "./modules/folders/folders.routes.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";
import { statsRoutes } from "./modules/stats/stats.routes.js";
import { storageConnectorRoutes } from "./modules/storageConnectors/storageConnectors.routes.js";
import { storageUsageRoutes } from "./modules/storageUsage/storageUsage.js";
import { uploadsRoutes } from "./modules/uploads/uploads.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { createServices, type Services } from "./services.js";
import { storageBrowserOrigin } from "./storage/index.js";
import type { AppContext } from "./types/context.js";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,100}$/;

export function createApp(ctx: AppContext): { app: Express; services: Services } {
  const s = createServices(ctx);
  const app = express();
  const limiters = createRateLimiters(s.config);

  app.disable("x-powered-by");
  app.set("trust proxy", /^\d+$/.test(s.config.trustProxy) ? Number(s.config.trustProxy) : s.config.trustProxy);
  app.set("query parser", "simple");

  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    req.id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", req.id);
    next();
  });

  app.use(
    pinoHttp({
      logger: s.logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url?.startsWith("/api/v1/health") ?? false },
      customProps: (req) => ({ userId: (req as express.Request).principal?.userId }),
      serializers: {
        // Log the path only: query strings may carry reset tokens.
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, path: req.url?.split("?")[0] }),
        // Status only: response headers are noise and add log-ingestion cost.
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  const storageOrigin = storageBrowserOrigin(s.config);
  // Pages (not API responses) need the origins of customer buckets in connect-src
  // so browsers may upload to them; only connectors actually configured are added.
  app.use(async (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    try {
      res.locals.connectorOrigins = (await s.storageResolver.connectorOrigins()).join(" ");
    } catch (err) {
      req.log?.warn({ err }, "Could not load storage connector origins for CSP");
    }
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "font-src": ["'self'"],
          "connect-src": [
            "'self'",
            ...(storageOrigin ? [storageOrigin] : []),
            (_req, res) => ((res as express.Response).locals.connectorOrigins as string | undefined) || "'self'",
          ],
          "frame-ancestors": ["'none'"],
          "form-action": ["'self'"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          ...(s.config.isProduction ? {} : { "upgrade-insecure-requests": null }),
        },
      },
      strictTransportSecurity: s.config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: "no-referrer" },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  );

  // CORS: only the configured frontend origins, with credentials.
  app.use("/api", (req, res, next) => {
    const origin = req.get("origin");
    if (origin && s.config.corsAllowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-CSRF-Token,X-Request-Id");
        res.setHeader("Access-Control-Max-Age", "600");
        return res.status(204).end();
      }
    }
    next();
  });

  // File contents never pass through the API, so request bodies stay small.
  app.use("/api", express.json({ limit: "256kb", strict: true }));
  app.use("/api", cookieParser());
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use("/api/v1/health", healthRoutes(s));
  app.use("/api", limiters.api);
  app.use("/api", loadSession(s));
  app.use("/api", csrfProtection(s));

  const v1 = express.Router();
  v1.use("/auth", authRoutes(s, limiters));
  v1.use(requireAuth);

  const folders = foldersRoutes(s);
  const documents = documentsRoutes(s);
  const uploads = uploadsRoutes(s);

  v1.use("/customers/:customerId/folders", folders.customerScoped);
  v1.use("/customers/:customerId/documents", documents.customerScoped);
  v1.use("/customers/:customerId/uploads", uploads.customerScoped);
  const connectors = storageConnectorRoutes(s);
  v1.use("/customers/:customerId/storage-connector", connectors.customerScoped);
  v1.use("/storage-connectors", connectors.global);
  v1.use("/customers/:customerId/storage-usage", storageUsageRoutes(s));
  v1.use("/customers", customersRoutes(s));
  v1.use("/users", usersRoutes(s));
  v1.use("/folders", folders.folderScoped);
  v1.use("/documents", documents.documentScoped);
  v1.use("/uploads", uploads.uploadScoped);
  v1.use("/audit-logs", auditRoutes(s));
  v1.use("/settings", settingsRoutes(s));
  v1.use("/stats", statsRoutes(s));

  app.use("/api/v1", v1);
  app.use("/api", notFoundHandler);

  // Optional: serve the built SPA from the same origin (recommended deployment).
  const dir = s.config.serveFrontendDir ? path.resolve(s.config.serveFrontendDir) : undefined;
  if (dir && existsSync(path.join(dir, "index.html"))) {
    app.use(express.static(dir, { index: false, maxAge: "1h", setHeaders: (res, file) => {
      if (/\/assets\//.test(file)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(dir, "index.html"));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler(s));
  return { app, services: s };
}
