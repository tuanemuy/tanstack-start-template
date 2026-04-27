import type { WithEvents } from "@/core/domain/common/event";
import { type TodoEvent, TodoEvents } from "./events";
import { type TodoId, TodoTitle } from "./valueObject";

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
 * deletion → gone (modelled as a `todo.deleted` event emitted from the
 * usecase layer; there is no `Todo.delete` because the aggregate produces
 * no state of its own at deletion time).
 */
export type ActiveTodo = TodoBase & Readonly<{ status: "active" }>;

/**
 * A todo that has been marked done.
 *
 * Transitions: `reopen` → `ActiveTodo`, `rename` → `CompletedTodo`,
 * deletion → gone.
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
 * domain operation that should "happen at the same instant". Likewise
 * `eventId` is supplied by the caller (via the `IdGenerator` port) — the
 * domain layer never mints ids itself.
 */
function complete(
  todo: ActiveTodo,
  eventId: string,
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
    events: [TodoEvents.toggled(eventId, next.id, true, now)],
  };
}

/**
 * Reopen a completed todo. Compile-time-guarded: cannot be called on an
 * `ActiveTodo`. See {@link complete} for the rationale on `now` / `eventId`.
 */
function reopen(
  todo: CompletedTodo,
  eventId: string,
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
    events: [TodoEvents.toggled(eventId, next.id, false, now)],
  };
}

export const Todo = {
  /** Type guard: the todo is still active (pending). */
  isActive: (todo: Todo): todo is ActiveTodo => todo.status === "active",

  /** Type guard: the todo has been completed. */
  isCompleted: (todo: Todo): todo is CompletedTodo =>
    todo.status === "completed",

  /**
   * Create a new todo aggregate. Always starts in the `active` state with
   * `version = 0`.
   *
   * `id` and the event id are supplied by the caller (via the application
   * layer's `IdGenerator` port) so the domain stays deterministic — no
   * `uuidv7()` at the bottom of the call stack. `now` is used for both
   * `createdAt` / `updatedAt` and the emitted event's `occurredAt`, so the
   * aggregate and its first event share an instant by construction.
   */
  create: (
    params: { id: TodoId; eventId: string; title: string },
    now: Date,
  ): WithEvents<ActiveTodo, TodoEvent> => {
    const todo: ActiveTodo = {
      status: "active",
      id: params.id,
      title: TodoTitle.create(params.title),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    return {
      entity: todo,
      events: [TodoEvents.created(params.eventId, todo.id, todo.title, now)],
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
    eventId: string,
    now: Date,
  ): WithEvents<T, TodoEvent> => {
    // Validate before the idempotency short-circuit: an invalid input is not
    // "the same as current", it is malformed. Comparing raw input against the
    // current (already-normalized) title would also let unnormalized inputs
    // slip past the short-circuit (e.g. "  foo  " vs "foo").
    const title = TodoTitle.create(newTitle);
    // `===` here is value equality: `TodoTitle` is a primitive `string` at
    // runtime (the brand is type-only), not a wrapper object.
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
      events: [TodoEvents.renamed(eventId, next.id, title, now)],
    };
  },

  complete,

  reopen,
};
