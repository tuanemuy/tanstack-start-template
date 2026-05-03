import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";
import { defineServerFn } from "@/core/presentation/serverFn";
import { validateInput } from "@/core/presentation/validator";

const TODO_LIST_MAX_LIMIT = 100;

// Strict shape for the `renderTodoList` RPC payload. `inputValidator` runs
// in both client and server bundles, so this schema avoids any domain
// imports.
const paginationSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(TODO_LIST_MAX_LIMIT),
});

// URL search variant. Coerces strings (URLs are stringly-typed) and falls
// back to defaults per-field so a hand-typed `?page=abc` never errors the
// route — bad RPC payloads still fail loud through `paginationSchema`.
export const paginationSearchSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce.number().int().min(1).max(TODO_LIST_MAX_LIMIT).catch(20),
});

export const renderTodoList = defineServerFn()
  .inputValidator(validateInput(paginationSchema))
  .handler(async ({ data }) => {
    const { TodoList } = await import("@/components/todo/TodoList");
    return renderServerComponent(<TodoList pagination={data} />);
  });
