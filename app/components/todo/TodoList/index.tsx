import type { Pagination } from "@/core/domain/common/pagination";
import { CreateTodoForm } from "../CreateTodoForm";
import { TodoItem } from "../TodoItem";
import { loadTodos } from "./action";

export async function TodoList({ pagination }: { pagination: Pagination }) {
  const { todos, count } = await loadTodos(pagination);

  return (
    <section>
      <h1>Todos ({count})</h1>
      <CreateTodoForm />
      {todos.length === 0 ? (
        <p>まだ Todo がありません。</p>
      ) : (
        <ul>
          {todos.map((todo) => (
            <TodoItem key={todo.id} todo={todo} />
          ))}
        </ul>
      )}
    </section>
  );
}
