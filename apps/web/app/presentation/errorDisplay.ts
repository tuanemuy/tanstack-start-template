import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";

function renderConflictMessage(code: string | null): string {
  switch (code) {
    case "OPTIMISTIC_LOCK_FAILURE":
      return "他の操作と競合しました。もう一度お試しください";
    case "UNIQUE_VIOLATION":
      return "すでに登録されています";
    case "FOREIGN_KEY_VIOLATION":
      return "依存関係があるため操作できません";
    default:
      return "他の操作と競合しました。もう一度お試しください";
  }
}

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

export function renderErrorMessage(error: SerializedError): string {
  switch (error.kind) {
    case "business":
      return error.message;
    case "notFound":
      return "対象が見つかりません";
    case "conflict":
      return renderConflictMessage(error.code);
    case "unauthorized":
      return "認証が必要です";
    case "forbidden":
      return "権限がありません";
    case "validation": {
      if (error.fieldErrors !== undefined) {
        const formatted = formatFieldErrors(error.fieldErrors);
        if (formatted !== null) return formatted;
      }
      return error.message;
    }
    case "system":
      return "システムエラーが発生しました";
    case "unknown":
      return "エラーが発生しました";
  }
}

export function displayError(error: unknown): string {
  return renderErrorMessage(extractSerializedError(error));
}

export function sanitizeRouteError(error: unknown): string {
  if (import.meta.env.DEV) {
    console.error("Route error:", error);
  } else {
    console.error("Route error");
  }
  return renderErrorMessage(extractSerializedError(error));
}
