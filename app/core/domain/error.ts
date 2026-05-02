import { CodedError, type SerializedErrorBase } from "@/lib/error";

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
