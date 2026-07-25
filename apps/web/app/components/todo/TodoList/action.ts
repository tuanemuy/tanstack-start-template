import type { Pagination } from "@repo/core/domain/common/pagination";
import { cache } from "react";
import { serverData } from "@/presentation/serverAction";

export const loadTodos = cache(
  serverData(
    () => import("@repo/core/application/todo/listTodos"),
    ({ container }, { listTodos }, pagination: Pagination) =>
      listTodos({ container, input: pagination }),
  ),
);
