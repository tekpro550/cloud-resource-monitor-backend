import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .optional()
    .transform((v) => (v === undefined ? def : ["true", "1", "yes"].includes(v)));

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const DEFAULT_EXTENSIONS =
  "pdf,doc,docx,xls,xlsx,xlsm,ppt,pptx,csv,txt,rtf,odt,ods,odp,png,jpg,jpeg,gif,tif,tiff,webp,zip,7z,gz,tar,xml,json,eml,msg,dwg,dxf";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(3000, 1),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  APP_BASE_URL: z.string().url(),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  TRUST_PROXY: z.string().default("loopback"),
  SERVE_FRONTEND_DIR: z.string().optional(),

  SESSION_TTL_SECONDS: int(12 * 3600, 300),
  SESSION_IDLE_TIMEOUT_SECONDS: int(30 * 60, 60),
  LOGIN_MAX_FAILED_ATTEMPTS: int(5, 1),
  LOGIN_LOCKOUT_SECONDS: int(15 * 60, 1),
  RATE_LIMIT_WINDOW_SECONDS: int(15 * 60, 1),
  RATE_LIMIT_MAX_REQUESTS: int(1000, 1),
  RATE_LIMIT_LOGIN_MAX: int(20, 1),
  RATE_LIMIT_PASSWORD_RESET_MAX: int(5, 1),
  PASSWORD_RESET_TTL_SECONDS: int(30 * 60, 60),
  INVITE_TTL_SECONDS: int(72 * 3600, 60),
  PASSWORD_MIN_LENGTH: int(12, 8),

  STORAGE_DRIVER: z.enum(["s3", "memory"]).default("s3"),
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_FORCE_PATH_STYLE: bool(false),
  STORAGE_PUBLIC_ORIGIN: z.string().url().optional(),
  STORAGE_REQUEST_TIMEOUT_MS: int(30_000, 1000),

  UPLOAD_MAX_FILE_SIZE_BYTES: int(5 * 1024 ** 3, 1),
  UPLOAD_MULTIPART_THRESHOLD_BYTES: int(100 * 1024 ** 2, 5 * 1024 ** 2),
  UPLOAD_PART_SIZE_BYTES: int(64 * 1024 ** 2, 5 * 1024 ** 2),
  UPLOAD_ALLOWED_EXTENSIONS: z.string().default(DEFAULT_EXTENSIONS),
  UPLOAD_URL_TTL_SECONDS: int(15 * 60, 60),
  UPLOAD_SESSION_TTL_SECONDS: int(24 * 3600, 300),
  DOWNLOAD_URL_TTL_SECONDS: int(300, 30),

  DELETED_DOCUMENT_RETENTION_DAYS: int(30, 0),
  JOBS_ENABLED: bool(false),
  JOBS_INTERVAL_SECONDS: int(15 * 60, 60),

  MAIL_DRIVER: z.enum(["smtp", "console", "disabled"]).default("disabled"),
  MAIL_FROM: z.string().default("Tekpro Document Portal <no-reply@localhost>"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587, 1),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  ALLOW_ADMIN_RESET_LINKS: bool(false),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env["NODE_ENV"];
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: Env["LOG_LEVEL"];
  databaseUrl: string;
  sessionSecret: string;
  appBaseUrl: string;
  corsAllowedOrigins: string[];
  trustProxy: string;
  serveFrontendDir?: string;
  session: { ttlSeconds: number; idleTimeoutSeconds: number; cookieName: string };
  login: { maxFailedAttempts: number; lockoutSeconds: number };
  rateLimit: { windowSeconds: number; maxRequests: number; loginMax: number; passwordResetMax: number };
  passwordResetTtlSeconds: number;
  inviteTtlSeconds: number;
  passwordMinLength: number;
  storage: {
    driver: Env["STORAGE_DRIVER"];
    endpoint?: string;
    region?: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
    publicOrigin?: string;
    requestTimeoutMs: number;
  };
  upload: {
    maxFileSizeBytes: number;
    multipartThresholdBytes: number;
    partSizeBytes: number;
    allowedExtensions: Set<string>;
    urlTtlSeconds: number;
    sessionTtlSeconds: number;
  };
  downloadUrlTtlSeconds: number;
  deletedDocumentRetentionDays: number;
  jobs: { enabled: boolean; intervalSeconds: number };
  mail: {
    driver: Env["MAIL_DRIVER"];
    from: string;
    smtp: { host?: string; port: number; secure: boolean; user?: string; password?: string };
  };
  allowAdminResetLinks: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Empty values (e.g. `STORAGE_ENDPOINT=` copied from .env.example) mean "not set".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";
  const problems: string[] = [];

  if (e.STORAGE_DRIVER === "s3") {
    for (const key of ["STORAGE_REGION", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"] as const) {
      if (!e[key]) problems.push(`${key} is required when STORAGE_DRIVER=s3`);
    }
  }
  if (isProduction) {
    if (e.STORAGE_DRIVER !== "s3") problems.push("STORAGE_DRIVER must be 's3' in production");
    if (!e.APP_BASE_URL.startsWith("https://")) problems.push("APP_BASE_URL must use https:// in production");
    if (e.MAIL_DRIVER === "console") problems.push("MAIL_DRIVER=console is not permitted in production");
    if (/change[-_ ]?me|example|secret/i.test(e.SESSION_SECRET)) {
      problems.push("SESSION_SECRET looks like a placeholder; generate a random value");
    }
  }
  if (e.MAIL_DRIVER === "smtp" && !e.SMTP_HOST) problems.push("SMTP_HOST is required when MAIL_DRIVER=smtp");
  if (e.UPLOAD_PART_SIZE_BYTES > 5 * 1024 ** 3) problems.push("UPLOAD_PART_SIZE_BYTES cannot exceed 5 GiB (S3 limit)");
  if (problems.length) {
    throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  const appOrigin = new URL(e.APP_BASE_URL).origin;
  const corsAllowedOrigins = Array.from(
    new Set([appOrigin, ...e.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)]),
  );

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    appBaseUrl: e.APP_BASE_URL.replace(/\/+$/, ""),
    corsAllowedOrigins,
    trustProxy: e.TRUST_PROXY,
    serveFrontendDir: e.SERVE_FRONTEND_DIR,
    session: {
      ttlSeconds: e.SESSION_TTL_SECONDS,
      idleTimeoutSeconds: e.SESSION_IDLE_TIMEOUT_SECONDS,
      // The __Host- prefix forces Secure, Path=/ and no Domain attribute in browsers.
      cookieName: isProduction ? "__Host-tdp_session" : "tdp_session",
    },
    login: { maxFailedAttempts: e.LOGIN_MAX_FAILED_ATTEMPTS, lockoutSeconds: e.LOGIN_LOCKOUT_SECONDS },
    rateLimit: {
      windowSeconds: e.RATE_LIMIT_WINDOW_SECONDS,
      maxRequests: e.RATE_LIMIT_MAX_REQUESTS,
      loginMax: e.RATE_LIMIT_LOGIN_MAX,
      passwordResetMax: e.RATE_LIMIT_PASSWORD_RESET_MAX,
    },
    passwordResetTtlSeconds: e.PASSWORD_RESET_TTL_SECONDS,
    inviteTtlSeconds: e.INVITE_TTL_SECONDS,
    passwordMinLength: e.PASSWORD_MIN_LENGTH,
    storage: {
      driver: e.STORAGE_DRIVER,
      endpoint: e.STORAGE_ENDPOINT,
      region: e.STORAGE_REGION,
      bucket: e.STORAGE_BUCKET ?? "memory-bucket",
      accessKeyId: e.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle: e.STORAGE_FORCE_PATH_STYLE,
      publicOrigin: e.STORAGE_PUBLIC_ORIGIN,
      requestTimeoutMs: e.STORAGE_REQUEST_TIMEOUT_MS,
    },
    upload: {
      maxFileSizeBytes: e.UPLOAD_MAX_FILE_SIZE_BYTES,
      multipartThresholdBytes: e.UPLOAD_MULTIPART_THRESHOLD_BYTES,
      partSizeBytes: e.UPLOAD_PART_SIZE_BYTES,
      allowedExtensions: new Set(
        e.UPLOAD_ALLOWED_EXTENSIONS.split(",").map((s) => s.trim().toLowerCase().replace(/^\./, "")).filter(Boolean),
      ),
      urlTtlSeconds: e.UPLOAD_URL_TTL_SECONDS,
      sessionTtlSeconds: e.UPLOAD_SESSION_TTL_SECONDS,
    },
    downloadUrlTtlSeconds: e.DOWNLOAD_URL_TTL_SECONDS,
    deletedDocumentRetentionDays: e.DELETED_DOCUMENT_RETENTION_DAYS,
    jobs: { enabled: e.JOBS_ENABLED, intervalSeconds: e.JOBS_INTERVAL_SECONDS },
    mail: {
      driver: e.MAIL_DRIVER,
      from: e.MAIL_FROM,
      smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, secure: e.SMTP_SECURE, user: e.SMTP_USER, password: e.SMTP_PASSWORD },
    },
    allowAdminResetLinks: e.ALLOW_ADMIN_RESET_LINKS,
  };
}
