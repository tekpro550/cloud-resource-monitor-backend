import { rateLimit } from "express-rate-limit";
import type { Request, Response } from "express";
import type { AppConfig } from "../config/env.js";

const handler = (_req: Request, res: Response) => {
  res.status(429).json({
    error: { code: "RATE_LIMITED", message: "Too many requests. Please wait and try again.", requestId: _req.id },
  });
};

/**
 * In-process rate limiters. They are per application instance; when running more
 * than one instance, configure a shared store (see docs/DEPLOYMENT.md).
 */
export function createRateLimiters(cfg: AppConfig) {
  const windowMs = cfg.rateLimit.windowSeconds * 1000;
  return {
    api: rateLimit({ windowMs, limit: cfg.rateLimit.maxRequests, standardHeaders: "draft-8", legacyHeaders: false, handler }),
    login: rateLimit({
      windowMs,
      limit: cfg.rateLimit.loginMax,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      handler,
    }),
    passwordReset: rateLimit({
      windowMs,
      limit: cfg.rateLimit.passwordResetMax,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler,
    }),
  };
}
