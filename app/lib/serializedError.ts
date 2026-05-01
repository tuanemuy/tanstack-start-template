/**
 * Wire-format envelope for an error crossing the server / client boundary.
 *
 * Lives in `app/lib/` because it is a transport contract shared by every
 * error producer (domain `BusinessRuleError`, application errors) and the
 * presentation layer that renders them.
 */

export type SerializedErrorKind =
  | "business"
  | "notFound"
  | "conflict"
  | "validation"
  | "system"
  | "unknown";

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

export type SerializedErrorBase = {
  code: string | null;
  message: string;
  retryable?: boolean;
};

export type SerializedValidationError = SerializedErrorBase & {
  kind: "validation";
  fieldErrors?: FieldErrors;
};

export type SerializedError =
  | (SerializedErrorBase & { kind: "business" })
  | (SerializedErrorBase & { kind: "notFound" })
  | (SerializedErrorBase & { kind: "conflict" })
  | SerializedValidationError
  | (SerializedErrorBase & { kind: "system" })
  | (SerializedErrorBase & { kind: "unknown" });

export interface SerializableError {
  toSerialized(): SerializedError;
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
