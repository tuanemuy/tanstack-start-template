import type { ZodType, z } from "zod";
import type { FieldErrors } from "@/lib/error";
import {
  AppServerError,
  type SerializedValidationError,
} from "./errorResponse";

/**
 * Transport-boundary input validator. Used inside
 * `createServerFn(...).inputValidator(validateInput(schema))` to assert that
 * the JSON shape matches the expected signature.
 *
 * Scope is intentionally narrow: this is a structural / DoS guard, NOT a
 * business-rule check. Domain invariants stay in value-object factories
 * (`TodoTitle.create`, `TodoId.create`) which the usecase exercises through
 * the entity factories. Accepting that split lets a usecase be invoked from
 * any entry point (server function, RSC loader, worker, test) without
 * dragging Zod through the application/domain layers.
 *
 * Sibling-only imports from `./errorResponse` are intentionally `import type`
 * for the variant shape — runtime stays at the presentation layer (which is
 * already in the client bundle), so no application/domain runtime leaks
 * into the client graph that `inputValidator` is part of.
 */
export function validateInput<T extends ZodType>(schema: T) {
  return (input: unknown): z.infer<T> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    const serialized: SerializedValidationError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      retryable: false,
      fieldErrors: zodIssuesToFieldErrors(parsed.error.issues),
    };
    throw new AppServerError(serialized);
  };
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
