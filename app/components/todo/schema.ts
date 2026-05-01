import { z } from "zod";

/**
 * Transport-boundary schemas for the Todo server functions. These are
 * shape / DoS checks only — domain invariants live in value-object
 * factories on the server side. Kept independent of `@/core/domain/todo/*`
 * so they stay safe to import from `actions.ts`, which ends up in the
 * client bundle via `inputValidator`.
 */

export const TODO_TITLE_MAX_LENGTH = 140;

export const createTodoSchema = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
});

export const changeTodoStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["active", "completed"]),
});

export const deleteTodoSchema = z.object({
  id: z.string().min(1),
});
