import { cache } from "react";
import { getContainer } from "@/core/application/di/server";
import { listTodos } from "@/core/application/todo/listTodos";
import { CreateTodoForm } from "./CreateTodoForm";
import { TodoItem } from "./TodoItem";

const loadTodos = cache(async () =>
  listTodos({ container: await getContainer(), input: undefined }),
);

export async function TodoList() {
  const { todos, count } = await loadTodos();

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
