import {
  isSerializableError,
  type SerializedError,
  type SerializedErrorKind,
} from "@/lib/serializedError";

export type {
  FieldErrors,
  SerializableError,
  SerializedError,
  SerializedErrorBase,
  SerializedErrorKind,
  SerializedValidationError,
} from "@/lib/serializedError";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}

/**
 * Classify any thrown value into a {@link SerializedError}. The protocol
 * is structural — anything that exposes `toSerialized()` is delegated to,
 * so adding a new error class never requires editing this function.
 */
export function serializeError(error: unknown): SerializedError {
  if (isSerializableError(error)) {
    return error.toSerialized();
  }
  return {
    kind: "unknown",
    code: null,
    message: errorMessage(error),
  };
}

const HTTP_STATUS_BY_KIND: Partial<Record<SerializedErrorKind, number>> = {
  notFound: 404,
  conflict: 409,
  validation: 422,
};

/**
 * Map a serialized error kind to its HTTP status. Returning `null` lets the
 * framework fall through to its default (500-class for thrown errors).
 */
export function httpStatusFor(serialized: SerializedError): number | null {
  return HTTP_STATUS_BY_KIND[serialized.kind] ?? null;
}

/**
 * Wire-format error wrapper for the server-function boundary. The carried
 * `serialized` envelope survives JSON / structured-clone.
 */
export class AppServerError extends Error {
  override readonly name = "AppServerError";

  constructor(public readonly serialized: SerializedError) {
    super(serialized.message);
  }

  toSerialized(): SerializedError {
    return this.serialized;
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
