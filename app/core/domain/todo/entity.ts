import type { WithEvents } from "@/core/domain/common/event";
import { type TodoEvent, TodoEvents } from "./events";
import { TodoId, TodoTitle } from "./valueObject";

type TodoBase = Readonly<{
  id: TodoId;
  title: TodoTitle;
  /**
   * Monotonic revision counter for optimistic locking.
   *
   * Starts at 0 when the aggregate is created and is incremented by 1 on
   * every successful mutation that alters state. Idempotent no-ops (e.g.
   * `rename` to the same title) do not bump it. Adapters compare this
   * value during update to detect concurrent writers.
   */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

/**
 * An open todo — still pending completion.
 *
 * Transitions: `complete` → `CompletedTodo`, `rename` → `ActiveTodo`,
 * `delete` → gone.
 */
export type ActiveTodo = TodoBase & Readonly<{ status: "active" }>;

/**
 * A todo that has been marked done.
 *
 * Transitions: `reopen` → `ActiveTodo`, `rename` → `CompletedTodo`,
 * `delete` → gone.
 */
export type CompletedTodo = TodoBase & Readonly<{ status: "completed" }>;

/**
 * Todo aggregate. Discriminated on `status`, so state-specific operations
 * (`complete`, `reopen`) can require the correct variant at compile time
 * and make illegal transitions unrepresentable.
 */
export type Todo = ActiveTodo | CompletedTodo;

/**
 * Mark an active todo complete. Compile-time-guarded: cannot be called on a
 * `CompletedTodo`, so "completing something already completed" is a type
 * error rather than a runtime no-op.
 *
 * `now` is taken as a parameter (rather than reaching for `new Date()`) so
 * the function stays pure: callers (typically the application layer) resolve
 * the current time once via the `Clock` port and thread that value into every
 * domain operation that should "happen at the same instant".
 */
function complete(
  todo: ActiveTodo,
  now: Date,
): WithEvents<CompletedTodo, TodoEvent> {
  const next: CompletedTodo = {
    ...todo,
    status: "completed",
    version: todo.version + 1,
    updatedAt: now,
  };
  return {
    entity: next,
    events: [TodoEvents.toggled(next.id, true, now)],
  };
}

/**
 * Reopen a completed todo. Compile-time-guarded: cannot be called on an
 * `ActiveTodo`. See {@link complete} for the rationale on `now`.
 */
function reopen(
  todo: CompletedTodo,
  now: Date,
): WithEvents<ActiveTodo, TodoEvent> {
  const next: ActiveTodo = {
    ...todo,
    status: "active",
    version: todo.version + 1,
    updatedAt: now,
  };
  return {
    entity: next,
    events: [TodoEvents.toggled(next.id, false, now)],
  };
}

/**
 * Flip between `active` and `completed`. Declared as an overloaded function
 * so that the result type preserves the opposite variant at compile time —
 * `toggle(ActiveTodo, now)` is typed as `WithEvents<CompletedTodo, …>` and
 * vice versa. Callers that pass the union fall back to `WithEvents<Todo, …>`.
 *
 * The runtime implementation dispatches on `status` so the
 * "illegal transition" invariants of `complete` / `reopen` stay intact.
 */
function toggle(
  todo: ActiveTodo,
  now: Date,
): WithEvents<CompletedTodo, TodoEvent>;
function toggle(
  todo: CompletedTodo,
  now: Date,
): WithEvents<ActiveTodo, TodoEvent>;
function toggle(todo: Todo, now: Date): WithEvents<Todo, TodoEvent>;
function toggle(todo: Todo, now: Date): WithEvents<Todo, TodoEvent> {
  switch (todo.status) {
    case "active":
      return complete(todo, now);
    case "completed":
      return reopen(todo, now);
    default: {
      // Exhaustiveness: adding a new `status` variant becomes a compile
      // error here because `_exhaustive: never` would no longer hold.
      const _exhaustive: never = todo;
      return _exhaustive;
    }
  }
}

export const Todo = {
  /** Type guard: the todo is still active (pending). */
  isActive: (todo: Todo): todo is ActiveTodo => todo.status === "active",

  /** Type guard: the todo has been completed. */
  isCompleted: (todo: Todo): todo is CompletedTodo =>
    todo.status === "completed",

  /**
   * Exhaustive pattern match over the `status` union.
   *
   * Use when both variants need distinct handling and the compiler should
   * enforce that every case is covered (adding a new variant would become
   * a compile error here until handled).
   */
  match: <R>(
    todo: Todo,
    handlers: {
      active: (t: ActiveTodo) => R;
      completed: (t: CompletedTodo) => R;
    },
  ): R => {
    switch (todo.status) {
      case "active":
        return handlers.active(todo);
      case "completed":
        return handlers.completed(todo);
      default: {
        // Exhaustiveness sentinel: adding a new `status` variant becomes a
        // compile error here until this switch is updated.
        const _exhaustive: never = todo;
        return _exhaustive;
      }
    }
  },

  /**
   * Create a new todo aggregate. Always starts in the `active` state with
   * `version = 0`.
   *
   * `now` is required and is used for both `createdAt` and `updatedAt` plus
   * the emitted event's `occurredAt`, so the aggregate and its first
   * event share an instant by construction.
   */
  create: (
    params: { title: string },
    now: Date,
  ): WithEvents<ActiveTodo, TodoEvent> => {
    const todo: ActiveTodo = {
      status: "active",
      id: TodoId.generate(),
      title: TodoTitle.create(params.title),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    return {
      entity: todo,
      events: [TodoEvents.created(todo.id, todo.title, now)],
    };
  },

  /**
   * Rename a todo. Variant-preserving: renaming an `ActiveTodo` yields an
   * `ActiveTodo`, renaming a `CompletedTodo` yields a `CompletedTodo`.
   *
   * Idempotent: if the normalized `newTitle` equals the current title, the
   * existing entity is returned unchanged with no events and no version
   * bump. This prevents spurious outbox traffic and useless `updatedAt`
   * churn when a client re-submits the same value.
   */
  rename: <T extends Todo>(
    todo: T,
    newTitle: string,
    now: Date,
  ): WithEvents<T, TodoEvent> => {
    // Validate before the idempotency short-circuit: an invalid input is not
    // "the same as current", it is malformed. Comparing raw input against the
    // current (already-normalized) title would also let unnormalized inputs
    // slip past the short-circuit (e.g. "  foo  " vs "foo").
    const title = TodoTitle.create(newTitle);
    if (title === todo.title) {
      return { entity: todo, events: [] };
    }
    const next = {
      ...todo,
      title,
      version: todo.version + 1,
      updatedAt: now,
    } as T;
    return {
      entity: next,
      events: [TodoEvents.renamed(next.id, title, now)],
    };
  },

  complete,

  reopen,

  toggle,

  /**
   * Delete a todo aggregate.
   *
   * Delete is terminal, so `entity` is `null` — `WithEvents<null, …>` is the
   * documented convention for aggregate removal. Callers must still route
   * the emitted `todo.deleted` event through `collectEvents` so that outbox
   * delivery is guaranteed.
   */
  delete: (todo: Todo, now: Date): WithEvents<null, TodoEvent> => ({
    entity: null,
    events: [TodoEvents.deleted(todo.id, now)],
  }),
};
