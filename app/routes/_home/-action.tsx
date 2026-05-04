import { renderServerComponent } from "@tanstack/react-start/rsc";
import { paginationSchema } from "@/core/presentation/pagination";
import { defineServerFn } from "@/core/presentation/serverFn";
import { validateInput } from "@/core/presentation/validator";

export const renderTodoList = defineServerFn()
  .inputValidator(validateInput(paginationSchema))
  .handler(async ({ data }) => {
    const { TodoList } = await import("@/components/todo/TodoList");
    return renderServerComponent(<TodoList pagination={data} />);
  });
