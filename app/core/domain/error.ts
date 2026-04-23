import { AnyError } from "@/lib/error";

/**
 * A business-rule error code.
 *
 * This is a plain string alias rather than a closed union so that the shared
 * error module stays domain-agnostic: each domain owns its own error codes
 * (e.g. `app/core/domain/todo/errorCode.ts`) and passes the string literal
 * through when constructing a `BusinessRuleError`.
 */
export type BusinessRuleErrorCode = string;

/**
 * Domain Layer - Business Rule Error
 *
 * Represents a violation of business rules in the domain layer.
 * Thrown when domain logic determines an operation cannot proceed.
 */
export class BusinessRuleError extends AnyError {
  override readonly name = "BusinessRuleError";

  constructor(
    public readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export function isBusinessRuleError(
  error: unknown,
): error is BusinessRuleError {
  return error instanceof BusinessRuleError;
}
