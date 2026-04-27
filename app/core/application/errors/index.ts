import { CodedError } from "@/lib/error";
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
 * Thin alias over the shared {@link CodedError} base in `app/lib/error.ts`.
 * The base owns the typed `code` field, the default `retryable: false`
 * getter, and the abstract `toSerialized()` contract — the same three-field
 * shape that `SystemError` and `BusinessRuleError` also expose. Keeping the
 * base in `app/lib/` lets every layer extend it without violating the
 * hexagonal direction (see the comment on `CodedError`).
 *
 * `TCode extends string` lets each subclass narrow `code` to its own literal
 * union so that `if (error.code === NotFoundErrorCode.TodoNotFound)` narrows
 * correctly at the call site.
 *
 * Subclasses expose a `retryable` metadata flag (defaulting to `false`) that
 * callers can consult without having to maintain an ambient "which codes
 * are safe to retry?" table. Cross-boundary code (e.g. server functions
 * mapping errors to HTTP status + retry advice) can rely on it.
 *
 * Subclasses also expose a `toSerialized()` method so the presentation layer
 * can convert any thrown value into a wire envelope through a single
 * structural check (`isSerializableError`) rather than enumerating concrete
 * classes via `instanceof`.
 */
export abstract class ApplicationError<
  TCode extends string = string,
> extends CodedError<TCode> {
  override readonly name: string = "ApplicationError";
}

export const NotFoundErrorCode = {
  NotFound: "NOT_FOUND",
  TodoNotFound: "TODO_NOT_FOUND",
} as const;
export type NotFoundErrorCode =
  (typeof NotFoundErrorCode)[keyof typeof NotFoundErrorCode];

export class NotFoundError extends ApplicationError<NotFoundErrorCode> {
  override readonly name = "NotFoundError";

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
} as const;
export type UnauthenticatedErrorCode =
  (typeof UnauthenticatedErrorCode)[keyof typeof UnauthenticatedErrorCode];

export class UnauthenticatedError extends ApplicationError<UnauthenticatedErrorCode> {
  override readonly name = "UnauthenticatedError";

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

/**
 * `SystemError` lives in `app/lib/systemError.ts` so adapter code can import
 * it without reaching upward into the application layer (hexagonal: adapters
 * depend on shared lib + domain ports, not on application-layer modules).
 *
 * Re-exported here so existing call sites that already think of "application
 * errors" as a single bucket — `import { SystemError } from
 * "@/core/application/errors"` — keep working without churn.
 */
export {
  isSystemError,
  SystemError,
  SystemErrorCode,
} from "@/lib/systemError";
