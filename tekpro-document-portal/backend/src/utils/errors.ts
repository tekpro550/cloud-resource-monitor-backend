export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "CSRF_INVALID"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DUPLICATE"
  | "FOLDER_NOT_EMPTY"
  | "INVALID_STATE"
  | "FILE_TOO_LARGE"
  | "STORAGE_QUOTA_EXCEEDED"
  | "FILE_TYPE_NOT_ALLOWED"
  | "UPLOAD_VERIFICATION_FAILED"
  | "UPLOAD_EXPIRED"
  | "ACCOUNT_LOCKED"
  | "RATE_LIMITED"
  | "STORAGE_UNAVAILABLE"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "VALIDATION_ERROR", message, details);
export const unauthenticated = (message = "Authentication required") => new AppError(401, "UNAUTHENTICATED", message);
export const forbidden = (message = "You do not have permission to perform this action") =>
  new AppError(403, "FORBIDDEN", message);
/**
 * Resources the caller may not see are reported as "not found" so identifiers of
 * other tenants' data cannot be probed.
 */
export const notFound = (resource = "Resource") => new AppError(404, "NOT_FOUND", `${resource} not found`);
export const conflict = (message: string, code: ErrorCode = "CONFLICT", details?: unknown) =>
  new AppError(409, code, message, details);
export const invalidState = (message: string) => new AppError(409, "INVALID_STATE", message);
