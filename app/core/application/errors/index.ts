import { AnyError } from "@/lib/error";
import type { SerializedError } from "@/lib/serializedError";

// Re-export the shared transport types so existing imports
// (`import { FieldErrors } from "@/core/application/errors"`) keep working.
// The canonical home of the type lives in `app/lib/serializedError.ts`
// because it is a transport contract shared with the presentation layer.
export type { FieldErrors, SerializedError } from "@/lib/serializedError";

import type { FieldErrors } from "@/lib/serializedError";

/**
 * Base application-layer error.
 *
 * `TCode extends string` lets each subclass narrow `code` to its own literal
 * union so that `if (error.code === NotFoundErrorCode.TodoNotFound)` narrows
 * correctly at the call site.
 *
 * Subclasses expose a `retryable` metadata flag (defaulting to `false`) that
 * callers can consult without having to maintain an ambient "which codes
 * are safe to retry?" table. The retry decorator in the adapter layer is
 * free to ignore this hint — it already has its own driver-level predicate
 * — but cross-boundary code (e.g. server functions mapping errors to HTTP
 * status + retry advice) can rely on it.
 *
 * Subclasses also expose a `toSerialized()` method so the presentation layer
 * can convert any thrown value into a wire envelope through a single
 * structural check (`isSerializableError`) rather than enumerating concrete
 * classes via `instanceof`.
 */
export abstract class ApplicationError<
  TCode extends string = string,
> extends AnyError {
  override readonly name: string = "ApplicationError";

  constructor(
    public readonly code: TCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }

  /**
   * Whether the caller can safely retry the operation that produced this
   * error. Subclasses that represent transient conditions override this to
   * return `true`.
   */
  get retryable(): boolean {
    return false;
  }

  /**
   * Lift this error into the wire envelope used by the presentation layer.
   * Concrete subclasses pin the discriminant `kind`.
   */
  abstract toSerialized(): SerializedError;
}

export const NotFoundErrorCode = {
  NotFound: "NOT_FOUND",
  TodoNotFound: "TODO_NOT_FOUND",
} as const;
export type NotFoundErrorCode =
  (typeof NotFoundErrorCode)[keyof typeof NotFoundErrorCode];

export class NotFoundError extends ApplicationError<NotFoundErrorCode> {
  override readonly name = "NotFoundError";
  // Missing resource — retrying would not change the outcome.
  override get retryable(): boolean {
    return false;
  }

  override toSerialized(): SerializedError {
    return {
      kind: "notFound",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
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
  // Conflict retry safety is command-specific. A stale-read conflict can be
  // retried for an idempotent "set this value" command, but not for a
  // non-idempotent "toggle" command. Usecases that know their command is safe
  // should retry locally after re-reading state; the transport should not infer
  // retryability from this error class alone.
  override get retryable(): boolean {
    return false;
  }

  override toSerialized(): SerializedError {
    return {
      kind: "conflict",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
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
  override get retryable(): boolean {
    return false;
  }

  override toSerialized(): SerializedError {
    return {
      kind: "unauthenticated",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
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
  override get retryable(): boolean {
    return false;
  }

  override toSerialized(): SerializedError {
    return {
      kind: "forbidden",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
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

  /**
   * Optional per-field breakdown of the failure. Populated by callers that
   * have a structured source (Zod issues, form-submit diagnostics, etc.);
   * undefined when the validation failure isn't tied to specific fields.
   */
  readonly fieldErrors?: FieldErrors;

  constructor(
    code: ValidationErrorCode,
    message: string,
    cause?: unknown,
    fieldErrors?: FieldErrors,
  ) {
    super(code, message, cause);
    if (fieldErrors !== undefined) {
      this.fieldErrors = fieldErrors;
    }
  }

  override get retryable(): boolean {
    return false;
  }

  override toSerialized(): SerializedError {
    if (this.fieldErrors !== undefined) {
      return {
        kind: "validation",
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        fieldErrors: this.fieldErrors,
      };
    }
    return {
      kind: "validation",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

/**
 * Convert a Zod `issues` array into {@link FieldErrors}.
 *
 * Keeps presentation-friendly mapping in one place so every usecase that
 * raises `ValidationError` from a Zod failure surfaces the same shape.
 */
export function zodIssuesToFieldErrors(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): FieldErrors {
  const acc: Record<string, string[]> = {};
  for (const issue of issues) {
    // Dotted-path key (`"foo.bar.0"`) matches Zod's default serialization.
    const key = issue.path.map((segment) => String(segment)).join(".");
    const bucket = acc[key] ?? [];
    bucket.push(issue.message);
    acc[key] = bucket;
  }
  return acc;
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

/**
 * Codes whose underlying failure is typically transient (external service
 * hiccup, network blip). Used to derive `retryable` on a `SystemError`.
 */
const RETRYABLE_SYSTEM_CODES: ReadonlySet<SystemErrorCode> =
  new Set<SystemErrorCode>([
    SystemErrorCode.NetworkError,
    SystemErrorCode.ExternalApiError,
  ]);

export class SystemError extends ApplicationError<SystemErrorCode> {
  override readonly name = "SystemError";
  override get retryable(): boolean {
    return RETRYABLE_SYSTEM_CODES.has(this.code);
  }

  override toSerialized(): SerializedError {
    return {
      kind: "system",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function isSystemError(error: unknown): error is SystemError {
  return error instanceof SystemError;
}
