import {
  extractSerializedError,
  type SerializedError,
  type SerializedErrorKind,
} from "@/core/presentation/errorResponse";

/**
 * Exhaustive message table keyed by {@link SerializedErrorKind}.
 *
 * Using a `Record<SerializedErrorKind, …>` instead of a `switch` makes a
 * missing variant a compile-time error the moment a new kind is added to
 * `SerializedError`. Handlers receive the fully-typed variant (`validation`
 * gets `fieldErrors`, others stay generic).
 *
 * Domain (`business`) and `validation` messages come from our own code, so we
 * pass them through verbatim. Infrastructural kinds (`system`, `unknown`)
 * fall back to generic copy — raw exception text must never reach the UI.
 */
type KindHandlers = {
  [K in SerializedErrorKind]: (
    error: Extract<SerializedError, { kind: K }>,
  ) => string;
};

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

const handlers: KindHandlers = {
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
  system: () => "システムエラーが発生しました",
  unknown: () => "エラーが発生しました",
};

/**
 * Render a `SerializedError` (or any thrown value) into a user-safe Japanese
 * message.
 */
export function renderErrorMessage(error: SerializedError): string {
  // Dispatch through the exhaustive table. The cast is necessary because
  // TypeScript cannot narrow `error` to the kind-specific variant through a
  // string-keyed lookup, but the `KindHandlers` type guarantees each handler
  // only sees its own variant.
  const handler = handlers[error.kind] as (error: SerializedError) => string;
  return handler(error);
}

/**
 * Render an unknown error into a user-safe Japanese message.
 */
export function displayError(error: unknown): string {
  return renderErrorMessage(extractSerializedError(error));
}

/**
 * Variant for route-level `errorComponent`s. Logs the raw error to the dev
 * console for visibility, then renders through the same exhaustive table so
 * route-level and inline messages stay consistent.
 */
export function sanitizeRouteError(error: unknown): string {
  if (import.meta.env.DEV) {
    console.error("Route error:", error);
  } else {
    console.error("Route error");
  }
  return renderErrorMessage(extractSerializedError(error));
}
