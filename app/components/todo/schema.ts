import { z } from "zod";

/**
 * Server-function input schemas, owned by the presentation layer. These
 * are intentionally independent of the domain — `actions.ts` is reachable
 * from the client bundle, so importing the domain's Zod schemas would drag
 * `BusinessRuleError` and the UUIDv7 generator into the client graph.
 *
 * Domain factories (`TodoTitle.create`, `TodoId.create`) remain the
 * authoritative final gate at runtime.
 */

export const TODO_TITLE_MAX_LENGTH = 140;

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const todoIdSchema = z.string().regex(UUID_V7_PATTERN);

export const createTodoSchema = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
});

export const changeTodoStatusSchema = z.object({
  id: todoIdSchema,
  status: z.enum(["active", "completed"]),
});

export const deleteTodoSchema = z.object({
  id: todoIdSchema,
});
