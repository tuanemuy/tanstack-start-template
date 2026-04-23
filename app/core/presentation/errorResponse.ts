import { isNotFound, isRedirect } from "@tanstack/react-router";
import {
  type ConflictError,
  type ForbiddenError,
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  isSystemError,
  isUnauthenticatedError,
  isValidationError,
  type NotFoundError,
  type SystemError,
  type UnauthenticatedError,
  type ValidationError,
} from "@/core/application/error";
import {
  type BusinessRuleError,
  isBusinessRuleError,
} from "@/core/domain/error";

/**
 * Discriminator for error kinds crossing the server/client boundary.
 */
export type SerializedErrorKind =
  | "business"
  | "notFound"
  | "conflict"
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "system"
  | "unknown";

/**
 * Transport-friendly representation of a domain/application error.
 *
 * Server functions return the full Error object to the client, but stack
 * traces and cause chains get in the way. We pack just what the UI needs —
 * a kind, optional code, and a message — into a plain object that survives
 * JSON serialization.
 */
export type SerializedError = {
  kind: SerializedErrorKind;
  code: string | null;
  message: string;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}

/**
 * Classify any thrown value into a {@link SerializedError}.
 */
export function serializeError(error: unknown): SerializedError {
  if (isBusinessRuleError(error)) {
    return {
      kind: "business",
      code: (error as BusinessRuleError).code,
      message: error.message,
    };
  }
  if (isNotFoundError(error)) {
    return {
      kind: "notFound",
      code: (error as NotFoundError).code,
      message: error.message,
    };
  }
  if (isConflictError(error)) {
    return {
      kind: "conflict",
      code: (error as ConflictError).code,
      message: error.message,
    };
  }
  if (isValidationError(error)) {
    return {
      kind: "validation",
      code: (error as ValidationError).code,
      message: error.message,
    };
  }
  if (isUnauthenticatedError(error)) {
    return {
      kind: "unauthenticated",
      code: (error as UnauthenticatedError).code,
      message: error.message,
    };
  }
  if (isForbiddenError(error)) {
    return {
      kind: "forbidden",
      code: (error as ForbiddenError).code,
      message: error.message,
    };
  }
  if (isSystemError(error)) {
    return {
      kind: "system",
      code: (error as SystemError).code,
      message: error.message,
    };
  }

  return {
    kind: "unknown",
    code: null,
    message: errorMessage(error),
  };
}

/**
 * Error wrapper used to carry a {@link SerializedError} across the server
 * function boundary.
 *
 * `serialized` is defined as an own, enumerable property so that even after
 * the runtime reduces this instance to a plain object (e.g. during JSON
 * round-trip) clients can still introspect it via
 * {@link extractSerializedError}.
 */
export class AppServerError extends Error {
  override readonly name = "AppServerError";
  // Assigned exactly once, via `Object.defineProperty` below. The `!`
  // assertion tells TypeScript that the field is installed before the
  // constructor returns — we cannot use a normal assignment because that
  // would clobber the non-writable descriptor we want here.
  readonly serialized!: SerializedError;

  constructor(serialized: SerializedError) {
    super(serialized.message);
    // Single assignment path: a non-writable / non-configurable /
    // enumerable own property. Enumerability is what lets the field
    // survive structured cloning / JSON serialization, so clients can
    // still introspect it via {@link extractSerializedError} after the
    // instance is reduced to a plain object.
    Object.defineProperty(this, "serialized", {
      value: serialized,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

export function isAppServerError(error: unknown): error is AppServerError {
  if (error instanceof AppServerError) return true;
  if (typeof error === "object" && error !== null && "serialized" in error) {
    const candidate = (error as { serialized?: unknown }).serialized;
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      "kind" in candidate &&
      "message" in candidate
    );
  }
  return false;
}

/**
 * Best-effort recovery of a {@link SerializedError} from anything thrown by
 * a server function.
 */
export function extractSerializedError(error: unknown): SerializedError {
  if (isAppServerError(error)) {
    return (error as AppServerError).serialized;
  }
  return serializeError(error);
}

/**
 * Helper for server function handlers: run the given callback and wrap any
 * non-{@link AppServerError} failure into one.
 */
export async function withErrorResponse<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    // TanStack Router's `redirect()` and `notFound()` throw sentinel values
    // that the router machinery catches upstream to drive navigation. They
    // are control flow, not errors — wrapping them in AppServerError would
    // surface an error UI instead of navigating. Re-throw unchanged so the
    // router sees them intact.
    if (isRedirect(error)) throw error;
    if (isNotFound(error)) throw error;
    if (isAppServerError(error)) throw error;
    throw new AppServerError(serializeError(error));
  }
}
