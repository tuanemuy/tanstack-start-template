import type { Pagination } from "@/core/domain/common/pagination";
import { TodoBoard } from "../TodoBoard";
import { loadTodos } from "./action";

export async function TodoList({ pagination }: { pagination: Pagination }) {
  const { todos, count } = await loadTodos(pagination);

  return <TodoBoard todos={todos} count={count} />;
}
