import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/core/presentation/errorResponseMiddleware";
import { loadServerDeps } from "@/core/presentation/serverAction";
import { validateInput } from "@/core/presentation/validator";
import { createTodoSchema } from "../schema";

export const createTodoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(createTodoSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@/core/application/todo/createTodo"),
    );
    return module.createTodo({ container, input: data });
  });
