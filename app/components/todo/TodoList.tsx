import { cache } from "react";
import { CreateTodoForm } from "./CreateTodoForm";
import { TodoItem } from "./TodoItem";

// Dynamic-import the DI / usecase modules so the static graph from this
// (server) component into client chunks stays free of drizzle / libsql.
const loadTodos = cache(async () => {
  const [{ getContainer }, { listTodos }] = await Promise.all([
    import("@/core/application/di/server"),
    import("@/core/application/todo/listTodos"),
  ]);
  return listTodos({ container: await getContainer() });
});

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
