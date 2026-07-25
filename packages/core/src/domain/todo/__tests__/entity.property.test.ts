import type { WithEventDrafts } from "@repo/core/domain/common/event";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
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
 * of the DSL walk below) take `id` and `now: Date` as required arguments;
 * the property generators feed deterministic stand-ins so the suite is
 * reproducible across runs.
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
const nextTodoId = (): TodoId => TodoId.create(nextRawId());

describe("Todo.complete / Todo.reopen (property)", () => {
  it("complete then reopen restores the original status", () => {
    fc.assert(
      fc.property(titleArb, (title) => {
        const { entity: initial } = Todo.create(
          { id: nextTodoId(), title },
          NOW,
        );
        const { entity: completed } = Todo.complete(initial, NOW);
        const { entity: reopened } = Todo.reopen(completed, NOW);
        expect(reopened.status).toBe(initial.status);
      }),
    );
  });

  it("each transition increments version by 1", () => {
    fc.assert(
      fc.property(titleArb, (title) => {
        const { entity: initial } = Todo.create(
          { id: nextTodoId(), title },
          NOW,
        );
        const { entity: completed } = Todo.complete(initial, NOW);
        const { entity: reopened } = Todo.reopen(completed, NOW);
        expect(completed.version).toBe(initial.version + 1);
        expect(reopened.version).toBe(completed.version + 1);
      }),
    );
  });

  it("emits exactly one todo.toggled draft per transition, auditing the new state", () => {
    fc.assert(
      fc.property(titleArb, fc.boolean(), (title, completeFirst) => {
        const { entity: created } = Todo.create(
          { id: nextTodoId(), title },
          NOW,
        );
        // Optionally complete first so we exercise both transition
        // directions.
        const { entity: initial, eventDrafts: setupDrafts } = completeFirst
          ? Todo.complete(created, NOW)
          : {
              entity: created,
              eventDrafts: [] as readonly Omit<TodoEvent, "id">[],
            };
        // Sanity: completing emits exactly one draft when we used it.
        expect(setupDrafts.length).toBeLessThanOrEqual(1);

        if (Todo.isActive(initial)) {
          const { entity: after, eventDrafts } = Todo.complete(initial, NOW);
          expect(after.status).toBe("completed");
          expect(eventDrafts).toHaveLength(1);
          const draft = eventDrafts[0];
          if (!draft || draft.type !== "todo.toggled") {
            expect.fail("expected a single todo.toggled draft");
            return;
          }
          // `complete` is variant-narrowing — the post-state is always
          // `completed`, so the audit event mirrors that literal.
          expect(draft.payload.completed).toBe(true);
          expect(draft.payload.todoId).toBe(initial.id);
        } else {
          const { entity: after, eventDrafts } = Todo.reopen(initial, NOW);
          expect(after.status).toBe("active");
          expect(eventDrafts).toHaveLength(1);
          const draft = eventDrafts[0];
          if (!draft || draft.type !== "todo.toggled") {
            expect.fail("expected a single todo.toggled draft");
            return;
          }
          // `reopen` is variant-narrowing — the post-state is always
          // `active`, so the audit event reports `completed: false`.
          expect(draft.payload.completed).toBe(false);
          expect(draft.payload.todoId).toBe(initial.id);
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
          { id: nextTodoId(), title: initial },
          NOW,
        );
        const { entity: renamed } = Todo.rename(created, next, NOW);
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
            { id: nextTodoId(), title: body },
            NOW,
          );
          const padded = `${" ".repeat(left)}${body}${" ".repeat(right)}`;
          const { entity: renamed, eventDrafts } = Todo.rename(
            created,
            padded,
            NOW,
          );
          expect(renamed).toBe(created);
          expect(renamed.version).toBe(created.version);
          expect(eventDrafts).toHaveLength(0);
        },
      ),
    );
  });

  it("version is bumped iff the title actually changed", () => {
    fc.assert(
      fc.property(titleArb, titleArb, (a, b) => {
        const { entity: created } = Todo.create(
          { id: nextTodoId(), title: a },
          NOW,
        );
        const { entity: renamed, eventDrafts } = Todo.rename(created, b, NOW);
        if (a === b) {
          // Pure idempotent path.
          expect(renamed.version).toBe(created.version);
          expect(eventDrafts).toHaveLength(0);
        } else {
          expect(renamed.version).toBe(created.version + 1);
          expect(eventDrafts).toHaveLength(1);
          expect(eventDrafts[0]?.type).toBe("todo.renamed");
        }
      }),
    );
  });
});

describe("Todo state transitions (property)", () => {
  it("every state-changing operation emits a single audit draft", () => {
    // Model state transitions as a small DSL and check that each
    // non-idempotent step produces exactly one draft. This guards against
    // accidental dropped events in future refactors. Deletion is now an
    // event-only step (no `Todo.delete` method) so the walk emits the
    // `TodoEvents.deleted(...)` draft directly.
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
          const { entity: created, eventDrafts: createDrafts } = Todo.create(
            { id: initialId, title: initialTitle },
            NOW,
          );
          expect(createDrafts).toHaveLength(1);
          expect(createDrafts[0]?.type).toBe("todo.created");

          // Widen to the Todo union so both `toggle` (which flips variant)
          // and `rename` (which preserves it) can assign through this ref.
          let current: TodoType = created;
          for (const [op, newTitle] of ops) {
            if (op === "create" || op === "delete") {
              // `create` doesn't apply inside the loop (already did once);
              // `delete` is terminal — emit the draft directly and stop the
              // walk so we do not call methods on a freed aggregate.
              if (op === "delete") {
                const draft = TodoEvents.deleted(current.id, NOW);
                expect(draft.type).toBe("todo.deleted");
                expect(draft.payload.todoId).toBe(current.id);
                return;
              }
              continue;
            }
            if (op === "toggle") {
              const toggled: WithEventDrafts<TodoType, TodoEvent> =
                Todo.isActive(current)
                  ? Todo.complete(current, NOW)
                  : Todo.reopen(current, NOW);
              expect(toggled.eventDrafts).toHaveLength(1);
              expect(toggled.eventDrafts[0]?.type).toBe("todo.toggled");
              current = toggled.entity;
            } else {
              const changed = newTitle !== (current.title as unknown as string);
              const renamed: WithEventDrafts<TodoType, TodoEvent> = Todo.rename(
                current,
                newTitle,
                NOW,
              );
              if (changed) {
                expect(renamed.eventDrafts).toHaveLength(1);
                expect(renamed.eventDrafts[0]?.type).toBe("todo.renamed");
              } else {
                expect(renamed.eventDrafts).toHaveLength(0);
              }
              current = renamed.entity;
            }
          }
        },
      ),
    );
  });
});
