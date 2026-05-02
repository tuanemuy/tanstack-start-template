import { cache } from "react";
import { serverData } from "@/core/presentation/serverAction";

export const loadTodos = cache(
  serverData(
    () => import("@/core/application/todo/listTodos"),
    ({ container }, { listTodos }) => listTodos({ container }),
  ),
);
