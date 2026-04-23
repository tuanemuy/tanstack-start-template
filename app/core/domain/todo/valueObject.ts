import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { BusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "./errorCode";

const TODO_TITLE_MAX_LENGTH = 140;

// UUIDv7 pattern: standard UUID with version nibble `7` and RFC4122 variant
// nibble in {8,9,a,b}.
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Branded identifier for the `Todo` aggregate.
 *
 * Intentionally strict: we only accept UUIDv7 strings. Aggregate ids are
 * server-generated (`TodoId.generate`) and never come from client input, so
 * any non-UUIDv7 value reaching `TodoId.create` indicates corrupt storage or
 * a programming error. Rejecting up front prevents malformed ids from
 * leaking through the system.
 */
export type TodoId = string & { readonly brand: "TodoId" };

export const TodoId = {
  create: (id: string): TodoId => {
    if (!UUID_V7_PATTERN.test(id)) {
      throw new BusinessRuleError(TodoErrorCode.InvalidId, "Invalid todo id");
    }
    return id as TodoId;
  },
  generate: (): TodoId => uuidv7() as TodoId,
};

export type TodoTitle = string & { readonly brand: "TodoTitle" };

/**
 * Reusable Zod schema for a todo title.
 *
 * Exposed on `TodoTitle.schema` so that server-function validators (Conform,
 * form schemas, etc.) can share the exact same rules as the domain factory
 * without duplicating the `trim / min(1) / max(140)` truth. Schema output is
 * plain `string`; branding to `TodoTitle` happens only through the
 * `TodoTitle.create` factory so there is a single source of truth for the
 * nominal brand.
 */
const todoTitleSchema = z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH);

export const TodoTitle = {
  schema: todoTitleSchema,
  maxLength: TODO_TITLE_MAX_LENGTH,
  create: (raw: string): TodoTitle => {
    const result = todoTitleSchema.safeParse(raw);
    if (result.success) {
      return result.data as TodoTitle;
    }
    // Map zod's first issue to the matching domain error code. Zod emits
    // `too_small` when the trimmed value is shorter than `min(1)` and
    // `too_big` when it exceeds `max(140)`; any other failure (e.g. a
    // non-string input) falls through to the generic `TitleEmpty` code.
    const issue = result.error.issues[0];
    const code =
      issue?.code === "too_big"
        ? TodoErrorCode.TitleTooLong
        : TodoErrorCode.TitleEmpty;
    const message =
      code === TodoErrorCode.TitleTooLong
        ? `Todo title exceeds maximum length (${TODO_TITLE_MAX_LENGTH})`
        : "Todo title cannot be empty";
    throw new BusinessRuleError(code, message, result.error);
  },
};
