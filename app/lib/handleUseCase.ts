/**
 * Use case error handling utilities.
 *
 * Provides a unified way to handle errors from use cases
 * and map them to appropriate HTTP responses.
 */

import { ResultAsync } from "neverthrow";

import {
  isConflictError,
  isForbiddenError,
  isNotFoundError,
  isSystemError,
  isUnauthenticatedError,
  isValidationError,
} from "@/core/application/error";
import { isBusinessRuleError } from "@/core/domain/error";

export type HandleError = {
  message: string;
  status: number;
};

/**
 * Wrap a use case function call with error handling.
 *
 * Returns a ResultAsync that captures any thrown errors
 * and maps them to HandleError with appropriate HTTP status codes.
 */
export function handleUseCase<T>(
  fn: () => Promise<T>,
): ResultAsync<T, HandleError> {
  return ResultAsync.fromPromise(fn(), (error) => ({
    message: formatErrorMessage(error),
    status: getErrorStatusCode(error),
  })).orTee((error) => {
    // TODO: ログ戦略を考える
    console.error("Use case error:", error);
  });
}

/**
 * Map error types to HTTP status codes.
 */
function getErrorStatusCode(error: unknown): number {
  if (isUnauthenticatedError(error)) {
    return 401;
  }

  if (isForbiddenError(error)) {
    return 403;
  }

  if (isNotFoundError(error)) {
    return 404;
  }

  if (isConflictError(error)) {
    return 409;
  }

  if (isValidationError(error)) {
    return 400;
  }

  if (isBusinessRuleError(error)) {
    return 400;
  }

  if (isSystemError(error)) {
    return 500;
  }

  return 500;
}

/**
 * Format error message for user display.
 */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "予期しないエラーが発生しました";
}
