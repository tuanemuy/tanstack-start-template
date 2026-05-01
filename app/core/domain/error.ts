import { CodedError } from "@/lib/error";
import type { SerializedError } from "@/lib/serializedError";

export type BusinessRuleErrorCode = string;

/**
 * Domain-layer error. Each domain narrows `TCode` to its own literal-union
 * code type at the throw site (e.g. `BusinessRuleError<TodoErrorCode>`).
 */
export class BusinessRuleError<
  TCode extends string = never,
> extends CodedError<TCode> {
  override readonly name = "BusinessRuleError";

  override toSerialized(): SerializedError {
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
