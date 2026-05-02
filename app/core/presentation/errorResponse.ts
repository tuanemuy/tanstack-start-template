import type {
  SerializedConflictError,
  SerializedNotFoundError,
  SerializedSystemError,
  SerializedValidationError,
} from "@/core/application/errors";
import type { SerializedBusinessError } from "@/core/domain/error";
import { isSerializableError, type SerializedErrorBase } from "@/lib/error";

export type { SerializedValidationError } from "@/core/application/errors";
export type {
  FieldErrors,
  SerializableError,
  SerializedErrorBase,
} from "@/lib/error";

export type SerializedUnknownError = SerializedErrorBase & {
  kind: "unknown";
};

export type SerializedError =
  | SerializedBusinessError
  | SerializedNotFoundError
  | SerializedConflictError
  | SerializedValidationError
  | SerializedSystemError
  | SerializedUnknownError;

export type SerializedErrorKind = SerializedError["kind"];

const SERIALIZED_ERROR_KINDS = {
  business: true,
  notFound: true,
  conflict: true,
  validation: true,
  system: true,
  unknown: true,
} as const satisfies Record<SerializedErrorKind, true>;

function isSerializedError(
  value: SerializedErrorBase & { kind: string },
): value is SerializedError {
  return Object.hasOwn(SERIALIZED_ERROR_KINDS, value.kind);
}

const SYSTEM_ERROR_PUBLIC_MESSAGE = "System error";

function redactSystem(serialized: SerializedError): SerializedError {
  return serialized.kind === "system"
    ? { ...serialized, message: SYSTEM_ERROR_PUBLIC_MESSAGE }
    : serialized;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}

export function serializeError(error: unknown): SerializedError {
  if (!isSerializableError(error)) {
    return { kind: "unknown", code: null, message: errorMessage(error) };
  }
  const serialized = error.toSerialized();
  if (isSerializedError(serialized)) {
    return redactSystem(serialized);
  }
  return {
    kind: "unknown",
    code: serialized.code,
    message: serialized.message,
  };
}

// `null` is the intentional fall-through to the framework's default 500.
const HTTP_STATUS_BY_KIND: Record<SerializedErrorKind, number | null> = {
  business: 422,
  notFound: 404,
  conflict: 409,
  validation: 422,
  system: null,
  unknown: null,
};

export function httpStatusFor(serialized: SerializedError): number | null {
  return HTTP_STATUS_BY_KIND[serialized.kind];
}

export class AppServerError extends Error {
  override readonly name = "AppServerError";

  constructor(public readonly serialized: SerializedError) {
    super(serialized.message);
  }
}

export function isAppServerError(error: unknown): error is AppServerError {
  return error instanceof AppServerError;
}

export function extractSerializedError(error: unknown): SerializedError {
  if (isAppServerError(error)) {
    return error.serialized;
  }
  return serializeError(error);
}
