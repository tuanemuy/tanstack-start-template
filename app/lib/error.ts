export class AnyError extends Error {
  override readonly name: string = "AnyError";

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

export function fromUnknown(error: unknown): AnyError {
  if (error instanceof AnyError) return error;
  if (error instanceof Error) return new AnyError(error.message, error);
  if (typeof error === "string") return new AnyError(error);
  return new AnyError("Unknown error occurred", error);
}

/**
 * 例外をユーザー表示用メッセージに変換する汎用ヘルパー。
 *
 * 最上位の `error.message` のみを返す。インフラ層の詳細（cause チェーンの
 * 深部にある SQL エラーメッセージなど）が画面に露出しないようにするため、
 * 意図的に cause は辿らない。
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "予期しないエラーが発生しました";
}
