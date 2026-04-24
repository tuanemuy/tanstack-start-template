import { createServerFn } from "@tanstack/react-start";
import type { ZodType, z } from "zod";
import {
  ValidationError,
  ValidationErrorCode,
  zodIssuesToFieldErrors,
} from "@/core/application/errors";
import { AppServerError } from "@/core/presentation/errorResponse";
import {
  changeTodoStatusHandler,
  createTodoHandler,
  deleteTodoHandler,
} from "./actionHandlers";
import {
  changeTodoStatusWireSchema,
  createTodoWireSchema,
  deleteTodoWireSchema,
} from "./wireSchemas";

/**
 * Wrap a Zod schema as a `createServerFn` validator that converts a parse
 * failure into the same wire envelope the application layer would emit for
 * a `ValidationError`. The client treats every validation failure — wire-
 * or usecase-level — uniformly: `lastError.kind === "validation"` plus
 * `lastError.fieldErrors`.
 *
 * The validator runs before the server-function handler, so it cannot
 * rely on `withErrorResponse` to wrap the throw; we emit `AppServerError`
 * directly.
 */
function wireValidator<TSchema extends ZodType>(schema: TSchema) {
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

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(wireValidator(createTodoWireSchema))
  .handler(({ data }) => createTodoHandler(data));

export const changeTodoStatusFn = createServerFn({ method: "POST" })
  .inputValidator(wireValidator(changeTodoStatusWireSchema))
  .handler(({ data }) => changeTodoStatusHandler(data));

export const deleteTodoFn = createServerFn({ method: "POST" })
  .inputValidator(wireValidator(deleteTodoWireSchema))
  .handler(({ data }) => deleteTodoHandler(data));
