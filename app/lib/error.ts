import type { SerializedError } from "@/lib/serializedError";

export class AnyError extends Error {
  override readonly name: string = "AnyError";

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

export function isError(error: unknown): error is Error {
  return error instanceof Error;
}

export function fromUnknown(error: unknown): AnyError {
  if (error instanceof AnyError) return error;
  if (error instanceof Error) return new AnyError(error.message, error);
  if (typeof error === "string") return new AnyError(error);
  return new AnyError("Unknown error occurred", error);
}

/**
 * 例外をユーザー表示用メッセージに変換する汎用ヘルパー。
 *
 * 最上位の `error.message` のみを返す。インフラ層の詳細（cause チェーンの
 * 深部にある SQL エラーメッセージなど）が画面に露出しないようにするため、
 * 意図的に cause は辿らない。
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "予期しないエラーが発生しました";
}

/**
 * Shared abstract base for every error class that carries a typed `code`,
 * a `retryable` classification, and a wire-serialization method.
 *
 * ## Why this lives in `app/lib/`
 *
 * `SystemError`, `ApplicationError` (and its subclasses), and
 * `BusinessRuleError` all expose the same three-field contract: a typed
 * `code: TCode`, a `retryable: boolean` getter, and a `toSerialized():
 * SerializedError` method. Before this base existed each class re-declared
 * the contract independently, and `SystemError` had to "duck-type" its way
 * into compatibility with `ApplicationError` because adapters cannot import
 * upward into `core/application/`.
 *
 * Putting the base here in `app/lib/` (alongside `AnyError` and the
 * `serializedError` wire contract — both already at the bottom of the
 * dependency graph) lets every layer extend it without violating the
 * hexagonal direction:
 *
 * - The adapter layer can `extends CodedError` (via `SystemError`) without
 *   reaching upward into the application layer.
 * - The application layer can `extends CodedError` (via `ApplicationError`)
 *   directly.
 * - The domain layer can `extends CodedError` (via `BusinessRuleError`).
 *
 * ## Why abstract
 *
 * `toSerialized()` is the concrete subclass's responsibility — each one
 * pins the discriminant `kind` of its `SerializedError` variant. `code`
 * and the default `retryable` getter are owned here so subclasses don't
 * re-declare them.
 */
export abstract class CodedError<
  TCode extends string = string,
> extends AnyError {
  override readonly name: string = "CodedError";

  constructor(
    public readonly code: TCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }

  /**
   * Whether the caller can safely retry the operation that produced this
   * error. Defaults to `false`; subclasses representing transient conditions
   * (e.g. `SystemError` for network/external-API failures) override this.
   */
  get retryable(): boolean {
    return false;
  }

  /**
   * Lift this error into the wire envelope used by the presentation layer.
   * Concrete subclasses pin the discriminant `kind`.
   */
  abstract toSerialized(): SerializedError;
}
