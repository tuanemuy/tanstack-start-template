import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/core/presentation/errorResponseMiddleware";
import { loadServerDeps } from "@/core/presentation/serverAction";
import { validateInput } from "@/core/presentation/validator";
import { changeTodoStatusSchema, renameTodoSchema } from "../schema";

export const changeTodoStatusFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(changeTodoStatusSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@/core/application/todo/changeTodoStatus"),
    );
    return module.changeTodoStatus({ container, input: data });
  });

export const renameTodoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(renameTodoSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@/core/application/todo/renameTodo"),
    );
    return module.renameTodo({ container, input: data });
  });
