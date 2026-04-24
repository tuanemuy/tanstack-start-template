import {
  extractSerializedError,
  type SerializedError,
  type SerializedErrorKind,
} from "@/core/presentation/errorResponse";

/**
 * Exhaustive message table keyed by {@link SerializedErrorKind}.
 *
 * Using a `Record<SerializedErrorKind, ...>` instead of a `switch` makes
 * missing variants a compile-time error the moment a new kind is added to
 * `SerializedError`. Handlers receive the fully-typed variant (`validation`
 * gets `fieldErrors`, others stay generic) so field-specific rendering stays
 * type-safe without runtime casts.
 *
 * Domain (`business`) and `validation` messages come from our own code, so
 * we pass them through verbatim. Infrastructural kinds (`system`, `unknown`)
 * fall back to generic copy — raw exception text (SQL, stack fragments)
 * must never reach the UI.
 */
type KindHandlers = {
  [K in SerializedErrorKind]: (
    error: Extract<SerializedError, { kind: K }>,
  ) => string;
};

/**
 * Render per-field validation messages into a single user-facing string.
 *
 * Prefers the first message per field to keep the summary short; callers
 * rendering a full form can pull `fieldErrors` directly from the serialized
 * error instead of using this.
 */
function formatFieldErrors(
  fieldErrors: Readonly<Record<string, readonly string[]>>,
): string | null {
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(fieldErrors)) {
    const first = messages[0];
    if (first === undefined) continue;
    parts.push(field ? `${field}: ${first}` : first);
  }
  return parts.length > 0 ? parts.join(" / ") : null;
}

const displayHandlers: KindHandlers = {
  business: (error) => error.message,
  notFound: () => "対象が見つかりません",
  // Conflict retry safety depends on the command, so display copy stays
  // generic. Idempotent usecases should retry internally after re-reading.
  conflict: () => "他の操作と競合しました。もう一度お試しください",
  validation: (error) => {
    if (error.fieldErrors !== undefined) {
      const formatted = formatFieldErrors(error.fieldErrors);
      if (formatted !== null) return formatted;
    }
    return error.message;
  },
  unauthenticated: () => "ログインが必要です",
  forbidden: () => "この操作を実行する権限がありません",
  system: () => "システムエラーが発生しました",
  unknown: () => "エラーが発生しました",
};

/**
 * Render an unknown error into a user-safe Japanese message.
 */
export function displayError(error: unknown): string {
  const serialized = extractSerializedError(error);
  // Dispatch through the exhaustive handler table. The cast is necessary
  // because TypeScript cannot narrow `serialized` to the kind-specific
  // variant expected by each handler through a string-keyed lookup, but the
  // `KindHandlers` type guarantees each handler only sees its own variant.
  const handler = displayHandlers[serialized.kind] as (
    error: SerializedError,
  ) => string;
  return handler(serialized);
}

/**
 * Route-level handler table. Errors surfaced to the router may include
 * transport / render failures that look nothing like our domain errors, so
 * we err toward generic copy for everything except the `business` and
 * `validation` kinds whose messages we author ourselves.
 */
const routeHandlers: KindHandlers = {
  business: (error) => error.message,
  notFound: () => "対象が見つかりません",
  conflict: () => "他の操作と競合しました。もう一度お試しください",
  validation: (error) => {
    if (error.fieldErrors !== undefined) {
      const formatted = formatFieldErrors(error.fieldErrors);
      if (formatted !== null) return formatted;
    }
    return error.message;
  },
  unauthenticated: () => "ログインが必要です",
  forbidden: () => "この操作を実行する権限がありません",
  system: () => "エラーが発生しました",
  unknown: () => "エラーが発生しました",
};

/**
 * Variant for route-level `errorComponent`s. Treats every failure as
 * potentially infrastructural (the router surfaces transport-level errors,
 * render failures, etc.) and avoids leaking raw exception messages. The
 * original error is logged to the dev console for visibility.
 */
export function sanitizeRouteError(error: unknown): string {
  if (import.meta.env.DEV) {
    console.error("Route error:", error);
  } else {
    console.error("Route error");
  }
  const serialized = extractSerializedError(error);
  const handler = routeHandlers[serialized.kind] as (
    error: SerializedError,
  ) => string;
  return handler(serialized);
}
