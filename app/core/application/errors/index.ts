import {
  CodedError,
  type FieldErrors,
  type SerializedErrorBase,
} from "@/lib/error";

export type { FieldErrors } from "@/lib/error";

export type SerializedNotFoundError = SerializedErrorBase & {
  kind: "notFound";
};

export type SerializedConflictError = SerializedErrorBase & {
  kind: "conflict";
};

export type SerializedValidationError = SerializedErrorBase & {
  kind: "validation";
  fieldErrors?: FieldErrors;
};

export type SerializedSystemError = SerializedErrorBase & {
  kind: "system";
};

export abstract class ApplicationError<
  TCode extends string = string,
> extends CodedError<TCode> {
  override readonly name: string = "ApplicationError";
}

export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}

export class NotFoundError extends ApplicationError {
  override readonly name = "NotFoundError";

  override toSerialized(): SerializedNotFoundError {
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

  override toSerialized(): SerializedConflictError {
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

  override toSerialized(): SerializedValidationError {
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

export class SystemError extends ApplicationError<SystemErrorCode> {
  override readonly name = "SystemError";

  override get retryable(): boolean {
    return RETRYABLE_SYSTEM_CODES.has(this.code);
  }

  override toSerialized(): SerializedSystemError {
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
