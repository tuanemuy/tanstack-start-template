import type { SerializedError } from "@/lib/serializedError";

/**
 * Shared base for every error class that carries a typed `code`, a
 * `retryable` classification, and a wire-serialization method.
 *
 * Lives in `app/lib/` so every layer (adapter / application / domain) can
 * extend it without violating the hexagonal direction.
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

  abstract toSerialized(): SerializedError;
}
