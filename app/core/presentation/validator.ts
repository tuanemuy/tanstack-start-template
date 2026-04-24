import type { ZodType, z } from "zod";
import {
  ValidationError,
  ValidationErrorCode,
  zodIssuesToFieldErrors,
} from "@/core/application/errors";
import { AppServerError } from "./errorResponse";

/**
 * Wrap a Zod schema as a server-function input validator that converts a
 * parse failure into the same wire envelope the application layer emits
 * for a `ValidationError`. Failures arrive on the client as
 * `lastError.kind === "validation"` plus `lastError.fieldErrors` —
 * uniform with usecase-thrown `ValidationError`s, so the form rendering
 * code only has to know one shape.
 *
 * The validator runs *before* the server-function handler, so it cannot
 * rely on `withErrorResponse` to wrap the throw; we emit `AppServerError`
 * directly.
 */
export function createValidator<TSchema extends ZodType>(schema: TSchema) {
  return (input: unknown): z.infer<TSchema> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) {
      return parsed.data as z.infer<TSchema>;
    }
    const error = new ValidationError(
      ValidationErrorCode.InvalidInput,
      "Invalid input",
      parsed.error,
      zodIssuesToFieldErrors(parsed.error.issues),
    );
    throw new AppServerError(error.toSerialized());
  };
}
