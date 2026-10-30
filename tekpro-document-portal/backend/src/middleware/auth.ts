import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "@prisma/client";
import type { Services } from "../services.js";
import { AppError, unauthenticated } from "../utils/errors.js";
import { safeEqual } from "../utils/crypto.js";
import type { Principal } from "../types/context.js";

export function sessionCookieOptions(s: Services, expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: s.config.isProduction,
    sameSite: "strict",
    path: "/",
    ...(expires ? { expires } : {}),
  };
}

export function clearSessionCookie(s: Services, res: Response) {
  res.clearCookie(s.config.session.cookieName, sessionCookieOptions(s));
}

/** Loads the principal (if any) from the session cookie. Does not reject anonymous requests. */
export function loadSession(s: Services): RequestHandler {
  return async (req, res, next) => {
    const token = req.cookies?.[s.config.session.cookieName] as string | undefined;
    if (!token) return next();
    const result = await s.auth.lookupSession(token);
    if (result.ok) {
      req.principal = result.principal;
    } else {
      clearSessionCookie(s, res);
      res.locals.sessionFailure = result.reason;
    }
    next();
  };
}

/** Rejects anonymous requests. Distinguishes an expired session so the UI can say so. */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.principal) return next();
  const reason = res.locals.sessionFailure as string | undefined;
  if (reason === "expired" || reason === "revoked" || reason === "inactive") {
    return next(new AppError(401, "SESSION_EXPIRED", "Your session has ended. Please sign in again."));
  }
  next(unauthenticated());
};

export function principal(req: Request): Principal {
  if (!req.principal) throw unauthenticated();
  return req.principal;
}

export function requireRoles(s: Services, ...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    s.policy.requireRole(principal(req), ...roles);
    next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 *  1. The session cookie is SameSite=Strict.
 *  2. If an Origin header is present it must be an allowed origin.
 *  3. Authenticated requests must echo the per-session CSRF token in
 *     X-CSRF-Token (synchroniser token pattern; the token is returned by
 *     /auth/login and /auth/me and kept in memory by the SPA).
 */
export function csrfProtection(s: Services): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get("origin");
    if (origin && !s.config.corsAllowedOrigins.includes(origin)) {
      return next(new AppError(403, "CSRF_INVALID", "Request origin is not allowed"));
    }
    // Login is exempt from the token check (the browser may hold a stale session);
    // it still passes the Origin check above and rotates the session.
    if (req.principal && req.originalUrl.split("?")[0] !== "/api/v1/auth/login") {
      const header = req.get("x-csrf-token") ?? "";
      if (!safeEqual(header, req.principal.csrfToken)) {
        return next(new AppError(403, "CSRF_INVALID", "Missing or invalid CSRF token. Refresh the page and try again."));
      }
    }
    next();
  };
}
