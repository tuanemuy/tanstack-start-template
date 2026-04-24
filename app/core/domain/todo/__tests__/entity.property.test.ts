import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { WithEvents } from "@/core/domain/common/event";
import { Todo, type Todo as TodoType } from "../entity";
import type { TodoEvent } from "../events";

/**
 * Property-based tests for Todo aggregate behaviour.
 *
 * These cover invariants that would be tedious to enumerate with example-
 * based tests: toggle idempotency, rename's effect on the title, state
 * transitions always emitting an auditable event.
 *
 * `Todo` factories now take a `now: Date` argument explicitly (no internal
 * `new Date()`), so the property generators can hand in a deterministic
 * timestamp and the tests stay reproducible across runs.
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

describe("Todo.toggle (property)", () => {
  it("is its own inverse — toggle(toggle(t)) has the same status as t", () => {
    fc.assert(
      fc.property(titleArb, (title) => {
        const { entity: initial } = Todo.create({ title }, NOW);
        const { entity: once } = Todo.toggle(initial, NOW);
        const { entity: twice } = Todo.toggle(once, NOW);
        expect(twice.status).toBe(initial.status);
      }),
    );
  });

  it("always increments version by 1 per toggle", () => {
    fc.assert(
      fc.property(titleArb, (title) => {
        const { entity: initial } = Todo.create({ title }, NOW);
        const { entity: once } = Todo.toggle(initial, NOW);
        const { entity: twice } = Todo.toggle(once, NOW);
        expect(once.version).toBe(initial.version + 1);
        expect(twice.version).toBe(once.version + 1);
      }),
    );
  });

  it("emits exactly one todo.toggled event per call, auditing the new state", () => {
    fc.assert(
      fc.property(titleArb, fc.boolean(), (title, startCompleted) => {
        const { entity: created } = Todo.create({ title }, NOW);
        // Optionally complete first so we exercise both transition
        // directions.
        const initial = startCompleted
          ? Todo.complete(created, NOW).entity
          : created;

        const { entity: after, events } = Todo.toggle(initial, NOW);
        expect(events).toHaveLength(1);
        const event = events[0];
        if (!event || event.type !== "todo.toggled") {
          expect.fail("expected a single todo.toggled event");
          return;
        }
        // `completed` on the event payload matches the post-toggle state.
        expect(event.payload.completed).toBe(after.status === "completed");
        expect(event.payload.todoId).toBe(initial.id);
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
        const { entity: created } = Todo.create({ title: initial }, NOW);
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
          const { entity: created } = Todo.create({ title: body }, NOW);
          const padded = `${" ".repeat(left)}${body}${" ".repeat(right)}`;
          const { entity: renamed, events } = Todo.rename(created, padded, NOW);
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
        const { entity: created } = Todo.create({ title: a }, NOW);
        const { entity: renamed, events } = Todo.rename(created, b, NOW);
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
    // accidental dropped events in future refactors.
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
          const { entity: created, events: createEvents } = Todo.create(
            { title: initialTitle },
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
              // `delete` is terminal — assert the event and stop the
              // walk so we do not call methods on a freed aggregate.
              if (op === "delete") {
                const { events } = Todo.delete(current, NOW);
                expect(events).toHaveLength(1);
                expect(events[0]?.type).toBe("todo.deleted");
                return;
              }
              continue;
            }
            if (op === "toggle") {
              const toggled: WithEvents<TodoType, TodoEvent> = Todo.toggle(
                current,
                NOW,
              );
              expect(toggled.events).toHaveLength(1);
              expect(toggled.events[0]?.type).toBe("todo.toggled");
              current = toggled.entity;
            } else {
              const changed = newTitle !== (current.title as unknown as string);
              const renamed: WithEvents<TodoType, TodoEvent> = Todo.rename(
                current,
                newTitle,
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
