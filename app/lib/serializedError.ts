/**
 * Wire-format envelope for an error crossing the server / client boundary.
 *
 * Lives in `app/lib/` because it is a transport contract — neither domain
 * logic, application orchestration, nor framework-specific presentation —
 * shared by every error producer (domain `BusinessRuleError`, application
 * `ApplicationError` subclasses) and the presentation layer that renders
 * them. Keeping the contract here breaks an otherwise-circular dependency:
 * presentation no longer needs to enumerate concrete error classes via
 * `instanceof`, and domain/application layers no longer need to know about
 * presentation modules to declare a `toSerialized` method.
 */

/**
 * Discriminator for error kinds crossing the server/client boundary.
 */
export type SerializedErrorKind =
  | "business"
  | "notFound"
  | "conflict"
  | "validation"
  | "unauthenticated"
  | "forbidden"
  | "system"
  | "unknown";

/**
 * Per-field validation issues.
 *
 * Shape matches the conventional "form errors" representation used by React
 * form libraries — a map from field path to an array of user-facing
 * messages — so presentation layers can render it alongside the offending
 * input without further normalization.
 */
export type FieldErrors = Readonly<Record<string, readonly string[]>>;

/**
 * Common fields carried by every serialized error variant.
 *
 * Discriminated by `kind` so that presentation-layer consumers can narrow to
 * variant-specific fields (`fieldErrors` for `validation`) without resorting
 * to runtime casts. `retryable` carries the application-layer retry hint so
 * the client can decide whether to auto-retry without re-classifying errors
 * from scratch.
 */
export type SerializedErrorBase = {
  code: string | null;
  message: string;
  /**
   * Whether the original application error was tagged as transient.
   * Mirrors the `retryable` getter on `ApplicationError`; `undefined` when the
   * source error had no retry metadata (e.g. unknown / domain errors).
   */
  retryable?: boolean;
};

export type SerializedValidationError = SerializedErrorBase & {
  kind: "validation";
  /**
   * Per-field issues mirrored from `ValidationError.fieldErrors`. Keyed by
   * dotted field path, values are the user-facing messages to render next to
   * each input.
   */
  fieldErrors?: FieldErrors;
};

export type SerializedError =
  | (SerializedErrorBase & { kind: "business" })
  | (SerializedErrorBase & { kind: "notFound" })
  | (SerializedErrorBase & { kind: "conflict" })
  | SerializedValidationError
  | (SerializedErrorBase & { kind: "unauthenticated" })
  | (SerializedErrorBase & { kind: "forbidden" })
  | (SerializedErrorBase & { kind: "system" })
  | (SerializedErrorBase & { kind: "unknown" });

/**
 * Structural contract every error producer must satisfy to be classified
 * by the presentation layer without `instanceof` enumeration.
 *
 * Concrete error classes (e.g. `BusinessRuleError`, `NotFoundError`) carry a
 * `toSerialized()` instance method whose return type matches `SerializedError`.
 * They do **not** need to `implements SerializableError` — TypeScript's
 * structural typing means anything with the right shape is automatically
 * compatible. New error classes added in the future just need to expose the
 * same method; presentation never has to be edited.
 */
export interface SerializableError {
  toSerialized(): SerializedError;
}

/**
 * Runtime guard for the structural {@link SerializableError} contract.
 *
 * Used by the presentation layer in place of an enumeration of concrete error
 * classes. Any value carrying a callable `toSerialized` property qualifies.
 */
export function isSerializableError(
  value: unknown,
): value is SerializableError {
  return (
    typeof value === "object" &&
    value !== null &&
    "toSerialized" in value &&
    typeof (value as { toSerialized: unknown }).toSerialized === "function"
  );
}
