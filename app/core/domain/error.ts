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
 *
 * `TCode extends string` lets each domain narrow `code` to its own literal
 * union at the throw site so that `if (error.code === TodoErrorCode.TitleTooLong)`
 * narrows correctly at the catch site. The default `<TCode extends string = string>`
 * keeps unparameterized uses (`BusinessRuleError`) assignable to the generic type.
 */
export class BusinessRuleError<TCode extends string = string> extends AnyError {
  override readonly name = "BusinessRuleError";

  constructor(
    public readonly code: TCode,
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
