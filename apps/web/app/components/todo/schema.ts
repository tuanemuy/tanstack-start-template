import { z } from "zod";

// Transport-boundary schemas — shape / DoS checks only. Independent of
// `@/core/domain/todo/*` so the client bundle that runs `inputValidator`
// never pulls in domain code.
export const TODO_TITLE_MAX_LENGTH = 140;

export const createTodoSchema = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
});

export const changeTodoStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["active", "completed"]),
});

export const renameTodoSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
});

export const deleteTodoSchema = z.object({
  id: z.string().min(1),
});
