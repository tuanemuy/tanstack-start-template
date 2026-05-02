import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EventId, type WithEvents } from "@/core/domain/common/event";
import { Todo, type Todo as TodoType } from "../entity";
import { type TodoEvent, TodoEvents } from "../events";
import { TodoId } from "../valueObject";

/**
 * Property-based tests for Todo aggregate behaviour.
 *
 * These cover invariants that would be tedious to enumerate with example-
 * based tests: complete/reopen idempotency, rename's effect on the title,
 * state transitions always emitting an auditable event.
 *
 * Both `Todo` factories and `TodoEvents.deleted` (used in the deletion arm
 * of the DSL walk below) take `id` / `eventId` and `now: Date` as required
 * arguments; the property generators feed deterministic stand-ins so the
 * suite is reproducible across runs.
 */

// fast-check arbitrary for a valid TodoTitle input (trimmed length in 1..140).
// Use lowercase letters so we never hit the zod whitespace / length branches
// accidentally.
const titleArb = fc.stringMatching(/^[a-z]{1,140}$/);

// Single fixed instant for every property invocation. Using a constant rather
// than `fc.date()` keeps the property focused on the structural invariant
// (toggle inverse, rename idempotency) without conflating it with timestamp
// behaviour.
const NOW = new Date(0);

// Stable id helpers — the domain no longer mints ids itself, so each property
// supplies its own. The fixed prefix keeps the values readable in fast-check
// shrinking output.
const ID_BASE = "00000000-0000-7000-8000-";
let counter = 0;
const nextRawId = (): string => {
  counter += 1;
  return `${ID_BASE}${counter.toString(16).padStart(12, "0")}`;
};
const nextEventId = (): EventId => EventId.create(nextRawId());
const nextTodoId = (): TodoId => TodoId.create(nextRawId());

describe("Todo.complete / Todo.reopen (property)", () => {
  it("complete then reopen restores the original status", () => {
    fc.assert(
      fc.property(titleArb, (title) => {
        const { entity: initial } = Todo.create(
          { id: nextTodoId(), eventId: nextEventId(), title },
          NOW,
        );
        const { entity: completed } = Todo.complete(
          initial,
          nextEventId(),
          NOW,
        );
        const { entity: reopened } = Todo.reopen(completed, nextEventId(), NOW);
        expect(reopened.status).toBe(initial.status);
      }),
    );
  });

  it("each transition increments version by 1", () => {
    fc.assert(
      fc.property(titleArb, (title) => {
        const { entity: initial } = Todo.create(
          { id: nextTodoId(), eventId: nextEventId(), title },
          NOW,
        );
        const { entity: completed } = Todo.complete(
          initial,
          nextEventId(),
          NOW,
        );
        const { entity: reopened } = Todo.reopen(completed, nextEventId(), NOW);
        expect(completed.version).toBe(initial.version + 1);
        expect(reopened.version).toBe(completed.version + 1);
      }),
    );
  });

  it("emits exactly one todo.toggled event per transition, auditing the new state", () => {
    fc.assert(
      fc.property(titleArb, fc.boolean(), (title, completeFirst) => {
        const { entity: created } = Todo.create(
          { id: nextTodoId(), eventId: nextEventId(), title },
          NOW,
        );
        // Optionally complete first so we exercise both transition
        // directions.
        const { entity: initial, events: setupEvents } = completeFirst
          ? Todo.complete(created, nextEventId(), NOW)
          : { entity: created, events: [] as readonly TodoEvent[] };
        // Sanity: completing emits exactly one event when we used it.
        expect(setupEvents.length).toBeLessThanOrEqual(1);

        if (Todo.isActive(initial)) {
          const { entity: after, events } = Todo.complete(
            initial,
            nextEventId(),
            NOW,
          );
          expect(after.status).toBe("completed");
          expect(events).toHaveLength(1);
          const event = events[0];
          if (!event || event.type !== "todo.toggled") {
            expect.fail("expected a single todo.toggled event");
            return;
          }
          // `complete` is variant-narrowing — the post-state is always
          // `completed`, so the audit event mirrors that literal.
          expect(event.payload.completed).toBe(true);
          expect(event.payload.todoId).toBe(initial.id);
        } else {
          const { entity: after, events } = Todo.reopen(
            initial,
            nextEventId(),
            NOW,
          );
          expect(after.status).toBe("active");
          expect(events).toHaveLength(1);
          const event = events[0];
          if (!event || event.type !== "todo.toggled") {
            expect.fail("expected a single todo.toggled event");
            return;
          }
          // `reopen` is variant-narrowing — the post-state is always
          // `active`, so the audit event reports `completed: false`.
          expect(event.payload.completed).toBe(false);
          expect(event.payload.todoId).toBe(initial.id);
        }
      }),
    );
  });
});

describe("Todo.rename (property)", () => {
  it("produces an entity whose title equals the normalized new title", () => {
    fc.assert(
      fc.property(titleArb, titleArb, (initial, next) => {
        // `fc.pre` would discard same-value samples too aggressively; the
        // test still passes when `initial === next` (see idempotency
        // property below) so no filtering is needed.
        const { entity: created } = Todo.create(
          { id: nextTodoId(), eventId: nextEventId(), title: initial },
          NOW,
        );
        const { entity: renamed } = Todo.rename(
          created,
          next,
          nextEventId(),
          NOW,
        );
        expect(renamed.title as unknown as string).toBe(next);
      }),
    );
  });

  it("renaming to the same (trimmed) title is a no-op — same instance, no events", () => {
    fc.assert(
      fc.property(
        titleArb,
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (body, left, right) => {
          const { entity: created } = Todo.create(
            { id: nextTodoId(), eventId: nextEventId(), title: body },
            NOW,
          );
          const padded = `${" ".repeat(left)}${body}${" ".repeat(right)}`;
          const { entity: renamed, events } = Todo.rename(
            created,
            padded,
            nextEventId(),
            NOW,
          );
          expect(renamed).toBe(created);
          expect(renamed.version).toBe(created.version);
          expect(events).toHaveLength(0);
        },
      ),
    );
  });

  it("version is bumped iff the title actually changed", () => {
    fc.assert(
      fc.property(titleArb, titleArb, (a, b) => {
        const { entity: created } = Todo.create(
          { id: nextTodoId(), eventId: nextEventId(), title: a },
          NOW,
        );
        const { entity: renamed, events } = Todo.rename(
          created,
          b,
          nextEventId(),
          NOW,
        );
        if (a === b) {
          // Pure idempotent path.
          expect(renamed.version).toBe(created.version);
          expect(events).toHaveLength(0);
        } else {
          expect(renamed.version).toBe(created.version + 1);
          expect(events).toHaveLength(1);
          expect(events[0]?.type).toBe("todo.renamed");
        }
      }),
    );
  });
});

describe("Todo state transitions (property)", () => {
  it("every state-changing operation emits a single audit event", () => {
    // Model state transitions as a small DSL and check that each
    // non-idempotent step produces exactly one event. This guards against
    // accidental dropped events in future refactors. Deletion is now an
    // event-only step (no `Todo.delete` method) so the walk emits the
    // `TodoEvents.deleted(...)` event directly.
    const opArb = fc.constantFrom(
      "create" as const,
      "toggle" as const,
      "rename" as const,
      "delete" as const,
    );

    fc.assert(
      fc.property(
        titleArb,
        fc.array(fc.tuple(opArb, titleArb), { minLength: 1, maxLength: 6 }),
        (initialTitle, ops) => {
          const initialId = nextTodoId();
          const { entity: created, events: createEvents } = Todo.create(
            { id: initialId, eventId: nextEventId(), title: initialTitle },
            NOW,
          );
          expect(createEvents).toHaveLength(1);
          expect(createEvents[0]?.type).toBe("todo.created");

          // Widen to the Todo union so both `toggle` (which flips variant)
          // and `rename` (which preserves it) can assign through this ref.
          let current: TodoType = created;
          for (const [op, newTitle] of ops) {
            if (op === "create" || op === "delete") {
              // `create` doesn't apply inside the loop (already did once);
              // `delete` is terminal — emit the event directly and stop the
              // walk so we do not call methods on a freed aggregate.
              if (op === "delete") {
                const event = TodoEvents.deleted(
                  nextEventId(),
                  current.id,
                  NOW,
                );
                expect(event.type).toBe("todo.deleted");
                expect(event.payload.todoId).toBe(current.id);
                return;
              }
              continue;
            }
            if (op === "toggle") {
              const toggled: WithEvents<TodoType, TodoEvent> = Todo.isActive(
                current,
              )
                ? Todo.complete(current, nextEventId(), NOW)
                : Todo.reopen(current, nextEventId(), NOW);
              expect(toggled.events).toHaveLength(1);
              expect(toggled.events[0]?.type).toBe("todo.toggled");
              current = toggled.entity;
            } else {
              const changed = newTitle !== (current.title as unknown as string);
              const renamed: WithEvents<TodoType, TodoEvent> = Todo.rename(
                current,
                newTitle,
                nextEventId(),
                NOW,
              );
              if (changed) {
                expect(renamed.events).toHaveLength(1);
                expect(renamed.events[0]?.type).toBe("todo.renamed");
              } else {
                expect(renamed.events).toHaveLength(0);
              }
              current = renamed.entity;
            }
          }
        },
      ),
    );
  });
});
