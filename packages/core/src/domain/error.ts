import { CodedError, type SerializedErrorBase } from "@repo/core/lib/error";

export type SerializedBusinessError = SerializedErrorBase & {
  kind: "business";
};

export class BusinessRuleError<
  TCode extends string = never,
> extends CodedError<TCode> {
  override readonly name = "BusinessRuleError";

  override toSerialized(): SerializedBusinessError {
    return {
      kind: "business",
      code: this.code,
      message: this.message,
      retryable: false,
    };
  }
}

export function isBusinessRuleError(
  error: unknown,
): error is BusinessRuleError<string> {
  return error instanceof BusinessRuleError;
}

/**
 * Raised when an aggregate's `reconstruct` cannot rebuild a valid entity
 * from a persisted row — i.e. the stored data violates an invariant that
 * fresh user input would have failed at value-object construction.
 *
 * Distinguishing this from `BusinessRuleError` matters because the two
 * carry different operational meanings even though they share the same
 * shape:
 * - `BusinessRuleError` from a usecase is "the actor's request is
 *   invalid" → maps to a 4xx user-visible error.
 * - `RehydrationError` is "the storage layer holds data we cannot
 *   safely turn back into a domain object" → an integrity / migration
 *   bug that adapters translate into `SystemError(DataIntegrityError)`.
 *
 * The original cause (typically a `BusinessRuleError` from a value
 * object) is preserved on `cause` so logs can pinpoint which invariant
 * failed without the upper layers having to enumerate value-object
 * error codes.
 */
export class RehydrationError extends Error {
  override readonly name = "RehydrationError";

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

export function isRehydrationError(error: unknown): error is RehydrationError {
  return error instanceof RehydrationError;
}
