import {
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  isSystemError,
  isUnauthenticatedError,
  isValidationError,
} from "@/core/application/error";
import { isBusinessRuleError } from "@/core/domain/error";

export class AnyError extends Error {
  override readonly name: string = "AnyError";
  override readonly cause?: AnyError | Error;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = isError(cause) ? cause : undefined;
  }
}

export function isError(error: unknown): error is AnyError | Error {
  return error instanceof Error || error instanceof AnyError;
}

export function fromUnknown(error: unknown): AnyError {
  if (error instanceof AnyError) {
    return error;
  }

  if (error instanceof Error) {
    return new AnyError(error.message, error);
  }

  if (typeof error === "string") {
    return new AnyError(error);
  }

  return new AnyError("Unknown error occurred", error);
}

/**
 * ドメイン/アプリケーション層の例外型を HTTP ステータスコードにマップする。
 *
 * `errorComponent` 内で表示用ステータスを決めたいときや、
 * フォームハンドラ内で intent 結果を生成するときに使う。
 */
export function getErrorStatusCode(error: unknown): number {
  if (isUnauthenticatedError(error)) return 401;
  if (isForbiddenError(error)) return 403;
  if (isNotFoundError(error)) return 404;
  if (isConflictError(error)) return 409;
  if (isValidationError(error)) return 400;
  if (isBusinessRuleError(error)) return 400;
  if (isSystemError(error)) return 500;
  return 500;
}

/**
 * 例外をユーザー表示用メッセージに変換する。
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "予期しないエラーが発生しました";
}
