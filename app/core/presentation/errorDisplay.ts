import {
  extractSerializedError,
  type SerializedError,
  type SerializedErrorKind,
} from "@/core/presentation/errorResponse";

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
  system: () => "システムエラーが発生しました",
  unknown: () => "エラーが発生しました",
};

export function renderErrorMessage(error: SerializedError): string {
  const handler = handlers[error.kind] as (error: SerializedError) => string;
  return handler(error);
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
