import type { ZodType, z } from "zod";
import type { FieldErrors } from "@/lib/error";
import {
  AppServerError,
  type SerializedValidationError,
} from "./errorResponse";

// Structural / DoS guard at the transport boundary. Business-rule validation
// belongs in value-object factories — keeping this scope narrow avoids
// dragging Zod through the application/domain layers and keeps it safe to
// run inside the client bundle that `inputValidator` enters.
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
