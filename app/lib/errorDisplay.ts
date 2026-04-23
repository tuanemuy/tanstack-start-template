import { extractSerializedError } from "@/core/application/errorResponse";

/**
 * Render an unknown error into a user-safe Japanese message.
 *
 * Domain (`business`) and `validation` errors are treated as user-visible —
 * their messages come from our own code. For infrastructural kinds
 * (`system`, `unknown`) we deliberately return a generic message so that
 * raw exception text (SQL details, stack fragments, etc.) never leaks to
 * the UI.
 */
export function displayError(error: unknown): string {
  const serialized = extractSerializedError(error);
  switch (serialized.kind) {
    case "business":
      return serialized.message;
    case "notFound":
      return "対象が見つかりません";
    case "conflict":
      return "他の操作と競合しました。再度お試しください";
    case "validation":
      return serialized.message;
    case "unauthenticated":
      return "ログインが必要です";
    case "forbidden":
      return "この操作を実行する権限がありません";
    case "system":
      return "システムエラーが発生しました";
    default:
      return "エラーが発生しました";
  }
}

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
  switch (serialized.kind) {
    case "business":
    case "validation":
      return serialized.message;
    case "notFound":
      return "対象が見つかりません";
    case "conflict":
      return "他の操作と競合しました。再度お試しください";
    case "unauthenticated":
      return "ログインが必要です";
    case "forbidden":
      return "この操作を実行する権限がありません";
    default:
      return "エラーが発生しました";
  }
}
