import { AnyError } from "@/lib/error";
import type { SerializedError } from "@/lib/serializedError";

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
 *
 * ## Usage pattern
 *
 * Each domain is expected to define a literal-union type alias for its
 * error codes (`const TodoErrorCode = { ... } as const;` + `type TodoErrorCode
 * = (typeof TodoErrorCode)[keyof typeof TodoErrorCode]`) and to instantiate
 * `BusinessRuleError<TodoErrorCode>` rather than the unparameterized form.
 * This makes catch-site narrowing meaningful — a free `TCode = string`
 * gives no more info than `unknown`, while a narrow literal union lets the
 * compiler check that every code was handled.
 *
 * ## Wire serialization
 *
 * `toSerialized()` lifts this error into the transport envelope used by the
 * presentation layer. Exposing the method on the class itself (rather than
 * having presentation enumerate concrete classes via `instanceof`) keeps
 * presentation closed to extension: adding a new domain or error variant
 * does not require editing the serializer.
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

  toSerialized(): SerializedError {
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
): error is BusinessRuleError {
  return error instanceof BusinessRuleError;
}
