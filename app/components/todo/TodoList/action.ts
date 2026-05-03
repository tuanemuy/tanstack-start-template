import { cache } from "react";
import type { Pagination } from "@/core/domain/common/pagination";
import { serverData } from "@/core/presentation/serverAction";

export const loadTodos = cache(
  serverData(
    () => import("@/core/application/todo/listTodos"),
    ({ container }, { listTodos }, pagination: Pagination) =>
      listTodos({ container, input: pagination }),
  ),
);
