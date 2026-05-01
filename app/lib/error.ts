/**
 * Shared error primitives for every layer.
 *
 * Lives in `app/lib/` so every layer can extend the structure without
 * violating the hexagonal direction. The full discriminated union of
 * concrete `kind`s is intentionally NOT defined here — each layer owns
 * its own variants and presentation assembles them into the public
 * `SerializedError` union.
 */

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export type SerializedErrorBase = {
  code: string | null;
  message: string;
  retryable?: boolean;
};

export interface SerializableError {
  toSerialized(): SerializedErrorBase & { kind: string };
}

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

/**
 * Shared base for every error class that carries a typed `code`, a
 * `retryable` classification, and a wire-serialization method.
 *
 * The return type of `toSerialized()` is intentionally structural — each
 * subclass narrows it to its own `kind`-tagged variant. The full union
 * is assembled at the presentation boundary, which is the only place
 * that needs to see every variant at once.
 */
export abstract class CodedError<TCode extends string = string> extends Error {
  override readonly name: string = "CodedError";

  constructor(
    public readonly code: TCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
  }

  get retryable(): boolean {
    return false;
  }

  abstract toSerialized(): SerializedErrorBase & { kind: string };
}
