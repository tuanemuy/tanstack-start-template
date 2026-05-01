import { CodedError } from "@/lib/error";
import type { FieldErrors, SerializedError } from "@/lib/serializedError";

export type { FieldErrors, SerializedError } from "@/lib/serializedError";

/**
 * Application-layer error family that maps cleanly to an HTTP status code.
 * Each subclass pins one status via {@link httpStatus}, consumed by
 * `withErrorResponse` to set the response status.
 */
export abstract class ApplicationError<
  TCode extends string = string,
> extends CodedError<TCode> {
  override readonly name: string = "ApplicationError";

  abstract get httpStatus(): number;
}

export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}

export class NotFoundError extends ApplicationError {
  override readonly name = "NotFoundError";

  override get httpStatus(): number {
    return 404;
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

export class ConflictError extends ApplicationError {
  override readonly name = "ConflictError";

  override get httpStatus(): number {
    return 409;
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

export class ValidationError extends ApplicationError {
  override readonly name = "ValidationError";

  readonly fieldErrors?: FieldErrors;

  constructor(
    code: string,
    message: string,
    cause?: unknown,
    fieldErrors?: FieldErrors,
  ) {
    super(code, message, cause);
    if (fieldErrors !== undefined) {
      this.fieldErrors = fieldErrors;
    }
  }

  override get httpStatus(): number {
    return 422;
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

export function zodIssuesToFieldErrors(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): FieldErrors {
  const acc: Record<string, string[]> = {};
  for (const issue of issues) {
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
  ExternalApiError: "EXTERNAL_API_ERROR",
} as const;
export type SystemErrorCode =
  (typeof SystemErrorCode)[keyof typeof SystemErrorCode];

const RETRYABLE_SYSTEM_CODES: ReadonlySet<SystemErrorCode> =
  new Set<SystemErrorCode>([
    SystemErrorCode.NetworkError,
    SystemErrorCode.ExternalApiError,
  ]);

/**
 * Low-level infrastructure failure (DB driver, network, storage). Surfaces
 * as a 500-class response.
 */
export class SystemError extends CodedError<SystemErrorCode> {
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
