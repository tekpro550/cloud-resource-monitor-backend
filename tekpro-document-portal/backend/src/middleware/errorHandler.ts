import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AuditAction } from "../modules/audit/audit.service.js";
import { AccessDeniedError } from "../modules/permissions/accessPolicy.js";
import type { Services } from "../services.js";
import { StorageError } from "../storage/storage.js";
import { AppError } from "../utils/errors.js";

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, "NOT_FOUND", "Endpoint not found"));
};

/**
 * Maps every error to the uniform response envelope
 *   { error: { code, message, details?, requestId } }
 * Internal details (stack traces, SQL, storage responses) are logged but never
 * returned to the client.
 */
export function errorHandler(s: Services): ErrorRequestHandler {
  return async (err, req, res, _next) => {
    let appErr: AppError;

    if (err instanceof AppError) {
      appErr = err;
    } else if (err instanceof ZodError) {
      appErr = new AppError(
        400,
        "VALIDATION_ERROR",
        "The request is invalid",
        err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    } else if (err instanceof StorageError) {
      req.log?.error({ err: { kind: err.kind, message: err.message } }, "Storage operation failed");
      appErr = new AppError(503, "STORAGE_UNAVAILABLE", "The document storage service is temporarily unavailable. Please try again.");
    } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      appErr = new AppError(409, "DUPLICATE", "A record with the same unique value already exists");
    } else if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2003" || err.code === "P2025")) {
      appErr = new AppError(409, "CONFLICT", "The request conflicts with the current state of related records");
    } else if ((err as { type?: string }).type === "entity.too.large") {
      appErr = new AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    } else if ((err as { type?: string }).type === "entity.parse.failed") {
      appErr = new AppError(400, "VALIDATION_ERROR", "Malformed JSON body");
    } else {
      req.log?.error({ err }, "Unhandled error");
      appErr = new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred");
    }

    if (err instanceof AccessDeniedError) {
      req.log?.warn({ reason: err.audit.reason, resourceType: err.audit.resourceType }, "Access denied");
      await s.audit.fromRequest(req, {
        action: AuditAction.ACCESS_DENIED,
        resourceType: err.audit.resourceType,
        resourceId: err.audit.resourceId ?? null,
        customerId: err.audit.customerId ?? null,
        outcome: "DENIED",
        metadata: { reason: err.audit.reason, method: req.method, path: req.route?.path ?? req.path },
      });
    }

    if (res.headersSent) return;
    res.status(appErr.status).json({
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.details !== undefined ? { details: appErr.details } : {}),
        requestId: req.id,
      },
    });
  };
}
