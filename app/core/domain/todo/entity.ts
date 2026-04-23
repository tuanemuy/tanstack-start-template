import type { WithEvents } from "@/core/domain/common/event";
import { BusinessRuleError } from "@/core/domain/error";
import { TodoErrorCode } from "./errorCode";
import { type TodoEvent, TodoEvents } from "./events";
import { TodoId, TodoTitle } from "./valueObject";

/**
 * Raw row shape used when rehydrating a `Todo` from persistence.
 *
 * Field types mirror what a SQL adapter typically returns — plain strings
 * and numbers without domain brands, dates either as `Date` objects or as
 * millisecond-epoch numbers / ISO strings depending on the driver. The
 * `completed` column is still a flat boolean (or 0/1 integer for SQLite)
 * at the storage layer; `fromPersistence` lifts that into the
 * `active | completed` discriminated union at the domain boundary.
 */
export type TodoPersistenceRaw = Readonly<{
  id: string;
  title: string;
  completed: boolean | number;
  version: number;
  createdAt: Date | string | number;
  updatedAt: Date | string | number;
}>;

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

function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BusinessRuleError(
      TodoErrorCode.InvalidId,
      "Invalid date value in persisted todo row",
    );
  }
  return parsed;
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
    }
  },

  /**
   * Create a new todo aggregate. Always starts in the `active` state with
   * `version = 0`.
   */
  create: (params: { title: string }): WithEvents<ActiveTodo, TodoEvent> => {
    const now = new Date();
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
      events: [TodoEvents.created(todo.id, todo.title)],
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
  ): WithEvents<T, TodoEvent> => {
    const title = TodoTitle.create(newTitle);
    if (title === todo.title) {
      return { entity: todo, events: [] };
    }
    const next = {
      ...todo,
      title,
      version: todo.version + 1,
      updatedAt: new Date(),
    } as T;
    return {
      entity: next,
      events: [TodoEvents.renamed(next.id, title)],
    };
  },

  /**
   * Mark an active todo complete. Compile-time-guarded: cannot be called
   * on a `CompletedTodo`, so "completing something already completed" is a
   * type error rather than a runtime no-op.
   */
  complete: (todo: ActiveTodo): WithEvents<CompletedTodo, TodoEvent> => {
    const next: CompletedTodo = {
      ...todo,
      status: "completed",
      version: todo.version + 1,
      updatedAt: new Date(),
    };
    return {
      entity: next,
      events: [TodoEvents.toggled(next.id, true)],
    };
  },

  /**
   * Reopen a completed todo. Compile-time-guarded: cannot be called on an
   * `ActiveTodo`.
   */
  reopen: (todo: CompletedTodo): WithEvents<ActiveTodo, TodoEvent> => {
    const next: ActiveTodo = {
      ...todo,
      status: "active",
      version: todo.version + 1,
      updatedAt: new Date(),
    };
    return {
      entity: next,
      events: [TodoEvents.toggled(next.id, false)],
    };
  },

  /**
   * Flip between `active` and `completed`. Overloaded so that the result
   * preserves the opposite variant at the type level — `toggle(ActiveTodo)`
   * is typed as `WithEvents<CompletedTodo, …>` and vice versa. Callers that
   * pass the union fall back to `WithEvents<Todo, …>`.
   */
  toggle: ((todo: Todo): WithEvents<Todo, TodoEvent> =>
    Todo.match<WithEvents<Todo, TodoEvent>>(todo, {
      active: (t) => Todo.complete(t),
      completed: (t) => Todo.reopen(t),
    })) as {
    (todo: ActiveTodo): WithEvents<CompletedTodo, TodoEvent>;
    (todo: CompletedTodo): WithEvents<ActiveTodo, TodoEvent>;
    (todo: Todo): WithEvents<Todo, TodoEvent>;
  },

  /**
   * Delete a todo aggregate.
   *
   * Returns `WithEvents<null, TodoEvent>`: the `entity` is `null` because
   * the aggregate is gone after this operation, but the emitted
   * `todo.deleted` event must still be routed through `collectEvent` so
   * that outbox delivery is guaranteed.
   */
  delete: (todo: Todo): WithEvents<null, TodoEvent> => ({
    entity: null,
    events: [TodoEvents.deleted(todo.id)],
  }),

  /**
   * Canonical rehydrator for a persisted todo row.
   *
   * Runs each raw field through its value-object factory so that invariants
   * are re-checked on every read, and lifts the flat `completed` boolean
   * into the `active | completed` discriminated union. Adapters must call
   * this rather than casting raw rows to `Todo` directly. Throws
   * `BusinessRuleError` when any invariant is violated (bad id format,
   * empty/too-long title, negative or non-integer version, etc.).
   */
  fromPersistence: (raw: TodoPersistenceRaw): Todo => {
    if (!Number.isInteger(raw.version) || raw.version < 0) {
      throw new BusinessRuleError(
        TodoErrorCode.InvalidVersion,
        `Invalid todo version in persisted row: ${raw.version}`,
      );
    }
    const completed =
      typeof raw.completed === "number" ? raw.completed !== 0 : raw.completed;
    const base: TodoBase = {
      id: TodoId.create(raw.id),
      title: TodoTitle.create(raw.title),
      version: raw.version,
      createdAt: toDate(raw.createdAt),
      updatedAt: toDate(raw.updatedAt),
    };
    return completed
      ? { ...base, status: "completed" }
      : { ...base, status: "active" };
  },
};
