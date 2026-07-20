import type {
  SerializedConflictError,
  SerializedForbiddenError,
  SerializedNotFoundError,
  SerializedSystemError,
  SerializedUnauthorizedError,
} from "@repo/core/application/errors";
import type { SerializedBusinessError } from "@repo/core/domain/error";
import {
  type FieldErrors,
  isSerializableError,
  type SerializedErrorBase,
} from "@repo/core/lib/error";

export type {
  FieldErrors,
  SerializableError,
  SerializedErrorBase,
} from "@repo/core/lib/error";

export type SerializedValidationError = SerializedErrorBase & {
  kind: "validation";
  fieldErrors?: FieldErrors;
};

export type SerializedUnknownError = SerializedErrorBase & {
  kind: "unknown";
};

export type SerializedError =
  | SerializedBusinessError
  | SerializedNotFoundError
  | SerializedConflictError
  | SerializedUnauthorizedError
  | SerializedForbiddenError
  | SerializedValidationError
  | SerializedSystemError
  | SerializedUnknownError;

export type SerializedErrorKind = SerializedError["kind"];

const SERIALIZED_ERROR_KINDS = {
  business: true,
  notFound: true,
  conflict: true,
  unauthorized: true,
  forbidden: true,
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}

// Raw structural projection. Kept un-redacted so server-side observers
// (logger, tracing) can see the original `code` / `message`. The transport
// boundary (`errorResponseMiddleware`) is responsible for running
// `redactForClient` exactly once before the value crosses to the client.
export function serializeError(error: unknown): SerializedError {
  if (!isSerializableError(error)) {
    return { kind: "unknown", code: null, message: errorMessage(error) };
  }
  const serialized = error.toSerialized();
  if (isSerializedError(serialized)) {
    return serialized;
  }
  return {
    kind: "unknown",
    code: serialized.code,
    message: serialized.message,
  };
}

// Strips server-internal detail before a `SerializedError` crosses the
// transport boundary. `system` and `unknown` can carry messages / codes that
// hint at internal layering (driver names, table names, network targets);
// exposing them to clients adds reconnaissance value with no UX upside.
// Apply at the response boundary only — server-side logs must use the raw
// form so operators retain the original code / message for triage.
export function redactForClient(serialized: SerializedError): SerializedError {
  if (serialized.kind === "system" || serialized.kind === "unknown") {
    return { ...serialized, code: null, message: SYSTEM_ERROR_PUBLIC_MESSAGE };
  }
  return serialized;
}

// `system` / `unknown` are mapped to an explicit 500 rather than relying on
// the framework default. This keeps the response status independent of
// runtime-specific defaults and makes the contract auditable in one place.
const HTTP_STATUS_BY_KIND: Record<SerializedErrorKind, number> = {
  business: 422,
  notFound: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  validation: 422,
  system: 500,
  unknown: 500,
};

export function httpStatusFor(serialized: SerializedError): number {
  return HTTP_STATUS_BY_KIND[serialized.kind];
}

export class AppServerError extends Error {
  override readonly name = "AppServerError";

  constructor(public readonly serialized: SerializedError) {
    super(serialized.message);
    // Adapter-bypassed transports fall back to seroval's default Error
    // serialization, leaking `.stack` to clients. `delete` (not `= undefined`)
    // because `exactOptionalPropertyTypes` rejects explicit undefined on
    // `Error.stack?: string`.
    delete this.stack;
  }
}

// Structural detection for the "adapter bypassed" path: when the Seroval
// serialization adapter isn't on the boundary the client receives a plain
// object (or plain Error) whose `serialized` own property survived the
// roundtrip, but `instanceof AppServerError` is false. UI consumers must go
// through `extractSerializedError` so this path stays transparent to them.
function hasSerializedRemnant(
  value: unknown,
): value is { serialized: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "serialized" in value &&
    typeof (value as { serialized: unknown }).serialized === "object" &&
    (value as { serialized: unknown }).serialized !== null
  );
}

function asSerializedError(value: unknown): SerializedError | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { kind?: unknown; message?: unknown };
  if (typeof v.kind !== "string" || typeof v.message !== "string") return null;
  return isSerializedError(v as SerializedErrorBase & { kind: string })
    ? (v as SerializedError)
    : null;
}

export function extractSerializedError(error: unknown): SerializedError {
  if (error instanceof AppServerError) {
    return error.serialized;
  }
  if (hasSerializedRemnant(error)) {
    const structural = asSerializedError(error.serialized);
    if (structural !== null) return structural;
  }
  return serializeError(error);
}
