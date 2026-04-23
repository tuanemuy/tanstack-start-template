import { AnyError } from "@/lib/error";

/**
 * Base application-layer error.
 *
 * `TCode extends string` lets each subclass narrow `code` to its own literal
 * union so that `if (error.code === NotFoundErrorCode.TodoNotFound)` narrows
 * correctly at the call site.
 */
export class ApplicationError<TCode extends string = string> extends AnyError {
  override readonly name: string = "ApplicationError";

  constructor(
    public readonly code: TCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export const NotFoundErrorCode = {
  NotFound: "NOT_FOUND",
  TodoNotFound: "TODO_NOT_FOUND",
} as const;
export type NotFoundErrorCode =
  (typeof NotFoundErrorCode)[keyof typeof NotFoundErrorCode];

export class NotFoundError extends ApplicationError<NotFoundErrorCode> {
  override readonly name = "NotFoundError";
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

export const ConflictErrorCode = {
  Conflict: "CONFLICT",
  OptimisticLockFailure: "OPTIMISTIC_LOCK_FAILURE",
} as const;
export type ConflictErrorCode =
  (typeof ConflictErrorCode)[keyof typeof ConflictErrorCode];

export class ConflictError extends ApplicationError<ConflictErrorCode> {
  override readonly name = "ConflictError";
}

export function isConflictError(error: unknown): error is ConflictError {
  return error instanceof ConflictError;
}

export const UnauthenticatedErrorCode = {
  AuthenticationRequired: "AUTHENTICATION_REQUIRED",
  TokenExpired: "TOKEN_EXPIRED",
  InvalidToken: "INVALID_TOKEN",
  UserNotFound: "USER_NOT_FOUND",
  InvalidAuthType: "INVALID_AUTH_TYPE",
  ProviderMismatch: "PROVIDER_MISMATCH",
  InvalidCredentials: "INVALID_CREDENTIALS",
} as const;
export type UnauthenticatedErrorCode =
  (typeof UnauthenticatedErrorCode)[keyof typeof UnauthenticatedErrorCode];

export class UnauthenticatedError extends ApplicationError<UnauthenticatedErrorCode> {
  override readonly name = "UnauthenticatedError";
}

export function isUnauthenticatedError(
  error: unknown,
): error is UnauthenticatedError {
  return error instanceof UnauthenticatedError;
}

export const ForbiddenErrorCode = {
  InsufficientPermissions: "INSUFFICIENT_PERMISSIONS",
} as const;
export type ForbiddenErrorCode =
  (typeof ForbiddenErrorCode)[keyof typeof ForbiddenErrorCode];

export class ForbiddenError extends ApplicationError<ForbiddenErrorCode> {
  override readonly name = "ForbiddenError";
}

export function isForbiddenError(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError;
}

export const ValidationErrorCode = {
  InvalidInput: "INVALID_INPUT",
} as const;
export type ValidationErrorCode =
  (typeof ValidationErrorCode)[keyof typeof ValidationErrorCode];

export class ValidationError extends ApplicationError<ValidationErrorCode> {
  override readonly name = "ValidationError";
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

export const SystemErrorCode = {
  InternalServerError: "INTERNAL_SERVER_ERROR",
  DatabaseError: "DATABASE_ERROR",
  NetworkError: "NETWORK_ERROR",
  StorageError: "STORAGE_ERROR",
  DocumentGenerationError: "DOCUMENT_GENERATION_ERROR",
  ExternalApiError: "EXTERNAL_API_ERROR",
} as const;
export type SystemErrorCode =
  (typeof SystemErrorCode)[keyof typeof SystemErrorCode];

export class SystemError extends ApplicationError<SystemErrorCode> {
  override readonly name = "SystemError";
}

export function isSystemError(error: unknown): error is SystemError {
  return error instanceof SystemError;
}
