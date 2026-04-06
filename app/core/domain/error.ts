// import { ${Domain}ErrorCode } from "./${domain}/errorCode";

import { AnyError } from "@/lib/error";

export const BusinessRuleErrorCode = {
  // ...${Domain}ErrorCode,
};

export type BusinessRuleErrorCode =
  (typeof BusinessRuleErrorCode)[keyof typeof BusinessRuleErrorCode];

/**
 * Domain Layer - Business Rule Error
 *
 * Represents a violation of business rules in the domain layer.
 * This error is thrown when domain logic determines that an operation cannot proceed.
 */
export class BusinessRuleError extends AnyError {
  override readonly name = "BusinessRuleError";

  constructor(
    public readonly code: BusinessRuleErrorCode,
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
