import type {
  GeneratedId,
  IdGenerator,
} from "@repo/core/application/ports/idGenerator";
import { CodedError, type FieldErrors } from "@repo/core/lib/error";
import type { ZodType, z } from "zod";
import {
  AppServerError,
  type SerializedValidationError,
} from "./errorResponse";

class InputValidationError extends CodedError {
  override readonly name = "InputValidationError";

  constructor(public readonly fieldErrors: FieldErrors) {
    super("INVALID_INPUT", "Invalid input");
  }

  override toSerialized(): SerializedValidationError {
    return {
      kind: "validation",
      code: this.code,
      message: this.message,
      retryable: false,
      fieldErrors: this.fieldErrors,
    };
  }
}

// Structural / DoS guard at the transport boundary. Business invariants live in
// value-object factories — keeping Zod out of application/domain also keeps
// this safe to run inside the client bundle `inputValidator` enters.
export function validateInput<T extends ZodType>(schema: T) {
  return (input: unknown): z.infer<T> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    const error = new InputValidationError(
      zodIssuesToFieldErrors(parsed.error.issues),
    );
    throw new AppServerError(error.toSerialized());
  };
}

/**
 * Transport-boundary parse of a client-minted aggregate id into the brand a
 * creating usecase requires. The schema only checks the shape: the format is
 * owned by the `IdGenerator` the container wires, which exists server-side
 * only, so the handler calls this once it holds the container.
 */
export function parseGeneratedId(
  idGenerator: IdGenerator,
  field: string,
  raw: string,
): GeneratedId {
  const id = idGenerator.parse(raw);
  if (id !== null) return id;
  const error = new InputValidationError({ [field]: ["Invalid id"] });
  throw new AppServerError(error.toSerialized());
}

function zodIssuesToFieldErrors(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>;
    readonly message: string;
  }>,
): FieldErrors {
  const acc: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map((segment) => String(segment)).join(".");
    const bucket = acc[key] ?? [];
    bucket.push(issue.message);
    acc[key] = bucket;
  }
  return acc;
}
