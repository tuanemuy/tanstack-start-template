import { createServerFn } from "@tanstack/react-start";
import { type ZodType, z } from "zod";
import {
  ValidationError,
  ValidationErrorCode,
  zodIssuesToFieldErrors,
} from "@/core/application/errors";
import { TodoTitle } from "@/core/domain/todo/valueObject";
import { AppServerError } from "@/core/presentation/errorResponse";
import {
  changeTodoStatusHandler,
  createTodoHandler,
  deleteTodoHandler,
} from "./actionHandlers";

/**
 * Zod validation policy for server functions
 * -----------------------------------------
 * Wire-format validators reuse the **domain's own Zod schemas** wherever the
 * domain exposes one (e.g. `TodoTitle.schema`). Two benefits:
 *
 *   1. Single source of truth. The trim / min / max rules for a Todo title
 *      live exactly once, in `app/core/domain/todo/valueObject.ts`. The wire
 *      validator imports that schema instead of re-declaring `z.string()`.
 *   2. Form-friendly errors. A wire-level rejection emits Zod issues with a
 *      proper `path`, which {@link zodIssuesToFieldErrors} turns into the
 *      same `fieldErrors` shape the UI already renders for application-layer
 *      `ValidationError`s. The client never has to know whether the failure
 *      was caught at the wire or inside the usecase.
 *
 * Schema output stays the **plain** wire shape (`string`, not branded
 * `TodoTitle`). Branding belongs to the domain factory (`TodoTitle.create`)
 * so there remains a single nominal-construction site, and so wire payloads
 * can flow through types like `CreateTodoWireInput` without accidentally
 * carrying brand markers across the network.
 *
 * For ids and other branded strings whose only constraint is "non-empty
 * string of correct shape", the domain factory (`TodoId.create`) is the
 * authoritative validator and runs inside the usecase. Wire validators here
 * apply only the minimum the transport needs to deliver a payload safely.
 */

/**
 * Wrap a Zod schema as a `createServerFn` validator that converts a parse
 * failure into the same wire envelope the application layer would emit for
 * a `ValidationError`. This lets the client treat every validation failure
 * — wire-level or usecase-level — the same way: `lastError.kind ===
 * "validation"` plus `lastError.fieldErrors`.
 *
 * The validator runs before the server-function handler, so it cannot rely
 * on `withErrorResponse` to do the wrapping for it; we throw an
 * `AppServerError` directly instead.
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
  .inputValidator(
    wireValidator(
      z.object({
        // Reuse the domain schema verbatim so the wire layer rejects empty /
        // over-long titles before the usecase is ever entered, and so the
        // failure path emits Zod issues with the `title` field path intact.
        title: TodoTitle.schema,
      }),
    ),
  )
  .handler(({ data }) => createTodoHandler(data));

export const changeTodoStatusFn = createServerFn({ method: "POST" })
  .inputValidator(
    wireValidator(
      z.object({
        // Wire-side `id` is left as a plain string; `TodoId.create` inside
        // the usecase performs the UUIDv7 check and raises a domain
        // `BusinessRuleError` on failure. Duplicating the regex here would
        // drift from the single source of truth in the domain factory.
        id: z.string().min(1),
        status: z.enum(["active", "completed"]),
      }),
    ),
  )
  .handler(({ data }) => changeTodoStatusHandler(data));

export const deleteTodoFn = createServerFn({ method: "POST" })
  .inputValidator(wireValidator(z.object({ id: z.string().min(1) })))
  .handler(({ data }) => deleteTodoHandler(data));
