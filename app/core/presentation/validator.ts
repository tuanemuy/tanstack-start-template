import { setResponseStatus } from "@tanstack/react-start/server";
import type { ZodType, z } from "zod";
import {
  ValidationError,
  zodIssuesToFieldErrors,
} from "@/core/application/errors";
import { AppServerError } from "./errorResponse";

/**
 * Wrap a Zod schema as a server-function input validator. Failures arrive
 * on the client as `lastError.kind === "validation"` plus
 * `lastError.fieldErrors`, uniform with usecase-thrown `ValidationError`s.
 *
 * The validator runs *before* the server-function handler, so it cannot
 * rely on `withErrorResponse` to wrap the throw — emit `AppServerError`
 * directly.
 */
export function createValidator<TSchema extends ZodType>(schema: TSchema) {
  return (input: unknown): z.infer<TSchema> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) {
      return parsed.data as z.infer<TSchema>;
    }
    const error = new ValidationError(
      "INVALID_INPUT",
      "Invalid input",
      parsed.error,
      zodIssuesToFieldErrors(parsed.error.issues),
    );
    setResponseStatus(error.httpStatus);
    throw new AppServerError(error.toSerialized());
  };
}
