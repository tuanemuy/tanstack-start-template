import { CodedError } from "@/lib/error";
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
 * Extends the shared {@link CodedError} base in `app/lib/error.ts`, which
 * owns the typed `code` field plus the default `retryable: false` getter.
 * Business-rule violations are never transient — fixing the underlying
 * input is the caller's responsibility — so the inherited default is
 * exactly right and `BusinessRuleError` does not override `retryable`.
 *
 * `TCode extends string` lets each domain narrow `code` to its own literal
 * union at the throw site so that `if (error.code === TodoErrorCode.TitleTooLong)`
 * narrows correctly at the catch site. The default is intentionally
 * `never` rather than `string`: an unparameterized `BusinessRuleError`
 * would let `code` widen back to `string` and silently lose narrowing at
 * every catch site, defeating the point of the generic. Forcing callers
 * to supply a concrete `TCode` (e.g. `BusinessRuleError<TodoErrorCode>`)
 * makes catch-site exhaustiveness checks meaningful. `instanceof
 * BusinessRuleError` checks remain valid because they don't depend on
 * the type parameter.
 *
 * ## Usage pattern
 *
 * Each domain is expected to define a literal-union type alias for its
 * error codes (`const TodoErrorCode = { ... } as const;` + `type TodoErrorCode
 * = (typeof TodoErrorCode)[keyof typeof TodoErrorCode]`) and to instantiate
 * `BusinessRuleError<TodoErrorCode>` rather than the unparameterized form.
 *
 * ## Wire serialization
 *
 * `toSerialized()` lifts this error into the transport envelope used by the
 * presentation layer. Exposing the method on the class itself (rather than
 * having presentation enumerate concrete classes via `instanceof`) keeps
 * presentation closed to extension: adding a new domain or error variant
 * does not require editing the serializer.
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

/**
 * Runtime guard for `BusinessRuleError`. The narrowed type uses `string` for
 * `TCode` (rather than the `BusinessRuleError` default of `never`) so that
 * `error.code` remains a string at the catch site even when the caller
 * doesn't know which domain's code union to expect. Catch sites that do
 * know the domain should narrow further by comparing against their own
 * `TodoErrorCode.*` constants.
 */
export function isBusinessRuleError(
  error: unknown,
): error is BusinessRuleError<string> {
  return error instanceof BusinessRuleError;
}
