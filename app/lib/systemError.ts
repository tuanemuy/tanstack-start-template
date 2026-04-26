import { AnyError } from "@/lib/error";
import type { SerializedError } from "@/lib/serializedError";

/**
 * SystemError — placed in `app/lib/` rather than `app/core/application/errors/`.
 *
 * Why here: `SystemError` represents a low-level failure (DB driver explosion,
 * network outage, storage hiccup) that any layer can surface — the adapter
 * layer wraps Drizzle exceptions, the application layer maps timeouts, and
 * even cross-cutting infrastructure can throw it. Putting it in
 * `core/application/errors` forced the adapter layer to import upward into
 * the application layer, breaking the hexagonal "adapter knows only domain
 * ports + shared lib" rule.
 *
 * `app/lib/` is the right home because it sits below every layer in the
 * dependency graph (alongside the wire-contract `serializedError.ts` and the
 * `AnyError` base). The application layer re-exports `SystemError` so that
 * existing imports keep working and so that workflow code that already
 * thinks of "application-layer errors" as a single bucket does not need
 * to special-case the import path.
 *
 * A separate file (rather than folding into `error.ts`) keeps `error.ts`
 * focused on the truly minimal `AnyError` base; `SystemError` carries its
 * own code union plus retry classification, which would crowd the base file.
 */

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

/**
 * SystemError is structurally compatible with the application-layer
 * `ApplicationError` base (carries a string `code`, a `retryable` getter, and
 * `toSerialized()`). It does not extend `ApplicationError` directly to avoid
 * a circular dependency: `ApplicationError` lives in the application layer,
 * and `SystemError` lives below it. The shared `SerializableError` structural
 * contract (in `app/lib/serializedError.ts`) is what the presentation layer
 * relies on, so this duck-typing is sufficient.
 */
export class SystemError extends AnyError {
  override readonly name = "SystemError";

  constructor(
    public readonly code: SystemErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }

  get retryable(): boolean {
    return RETRYABLE_SYSTEM_CODES.has(this.code);
  }

  toSerialized(): SerializedError {
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
