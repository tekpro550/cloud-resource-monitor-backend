import { pino, type Logger } from "pino";

/**
 * Paths that must never reach log output. Pre-signed URLs, cookies, passwords and
 * tokens are bearer credentials.
 */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "req.headers['x-csrf-token']",
  'res.headers["set-cookie"]',
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "url",
  "urls",
  "*.password",
  "*.token",
  "*.url",
  "*.secretAccessKey",
  "*.accessKeyId",
];

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: "tekpro-document-portal" },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}
