import { isNotFound, isRedirect } from "@tanstack/react-router";
import {
  isSerializableError,
  type SerializedError,
} from "@/lib/serializedError";

// Re-export the wire-format types so existing presentation-layer imports
// (`import { SerializedError } from "@/core/presentation/errorResponse"`)
// keep working. The canonical home is `app/lib/serializedError.ts` because
// the contract is shared with every error producer (domain / application).
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
 * Classify any thrown value into a {@link SerializedError}.
 *
 * The classification protocol is **structural**: any value that exposes a
 * `toSerialized()` method (the `SerializableError` contract in
 * `app/lib/serializedError.ts`) is delegated to. Concrete error classes
 * (domain `BusinessRuleError`, application `NotFoundError`, …) own their
 * own serialization logic, so this function never enumerates them via
 * `instanceof`. Adding a new error class — even from a brand-new domain —
 * does not require editing presentation.
 *
 * Anything that does not satisfy the protocol is classified as
 * `kind: "unknown"`.
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

  /**
   * Pass-through to the carried envelope. Lets `AppServerError` participate
   * in the same structural `SerializableError` contract as domain /
   * application errors so callers can route everything through
   * {@link serializeError} without a special case.
   */
  toSerialized(): SerializedError {
    return this.serialized;
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
