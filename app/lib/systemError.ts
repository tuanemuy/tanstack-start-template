import { CodedError } from "@/lib/error";
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
 * dependency graph (alongside the wire-contract `serializedError.ts`, the
 * `AnyError` base, and the shared `CodedError` base). The application layer
 * re-exports `SystemError` so that existing imports keep working and so that
 * workflow code that already thinks of "application-layer errors" as a
 * single bucket does not need to special-case the import path.
 *
 * ## Relationship to `CodedError`
 *
 * `SystemError` extends the shared `CodedError<SystemErrorCode>` base in
 * `app/lib/error.ts`. The base owns the typed `code` field, the default
 * `retryable: false` getter, and the abstract `toSerialized()` contract.
 * `SystemError` overrides `retryable` with a code-set predicate and
 * implements `toSerialized()` with `kind: "system"`. This eliminates the
 * earlier duck-typed parallel between `SystemError` and `ApplicationError`
 * — both now extend the same base — without forcing `SystemError` to
 * import from the application layer.
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
