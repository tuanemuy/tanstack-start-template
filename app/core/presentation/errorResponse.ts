import { isNotFound, isRedirect } from "@tanstack/react-router";
import { setResponseStatus } from "@tanstack/react-start/server";
import { isApplicationError } from "@/core/application/errors";
import {
  isSerializableError,
  type SerializedError,
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

/**
 * Wire-format error wrapper for the server-function boundary. The carried
 * `serialized` envelope survives JSON / structured-clone.
 */
export class AppServerError extends Error {
  override readonly name = "AppServerError";
  readonly _tag = "AppServerError" as const;

  constructor(public readonly serialized: SerializedError) {
    super(serialized.message);
  }

  toSerialized(): SerializedError {
    return this.serialized;
  }
}

export function isAppServerError(error: unknown): error is AppServerError {
  if (error instanceof AppServerError) return true;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return (error as { _tag?: unknown })._tag === "AppServerError";
  }
  return false;
}

export function extractSerializedError(error: unknown): SerializedError {
  if (isAppServerError(error)) {
    return (error as AppServerError).serialized;
  }
  return serializeError(error);
}

/**
 * Server-function handler wrapper. For application errors the HTTP status
 * is derived from `error.httpStatus`; non-application errors fall through
 * to the framework default (500-class). TanStack Router's `redirect()` /
 * `notFound()` sentinels are re-thrown verbatim to drive navigation.
 */
export async function withErrorResponse<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (isNotFound(error)) throw error;
    if (isAppServerError(error)) throw error;
    if (isApplicationError(error)) {
      setResponseStatus(error.httpStatus);
    }
    throw new AppServerError(serializeError(error));
  }
}
