import { describe, expect, it } from "vitest";
import { EventId } from "@/core/domain/common/event";
import { isBusinessRuleError } from "@/core/domain/error";
import { Todo } from "../entity";
import { TodoErrorCode } from "../errorCode";
import { TodoId } from "../valueObject";

// Centralised "now" so each test makes its time semantics explicit instead
// of relying on `new Date()` ambient I/O. We use `new Date(0)` (the unix
// epoch) plus delta offsets so the values are stable and easy to reason
// about in failure messages.
const T0 = new Date(0);
// `at(123)` reads as "the instant 123 ms after T0". Named `at` rather than
// `after` because Vitest exposes a global `after` test-hook and Biome flags
// the collision.
const at = (ms: number) => new Date(T0.getTime() + ms);

// Deterministic id helpers — id minting is no longer a domain concern, so
// these tests pre-mint UUIDv7 strings and pass them in. The fixed prefix
// keeps generated values readable in failure messages.
const ID_BASE = "00000000-0000-7000-8000-";
const id = (n: number): TodoId =>
  TodoId.create(`${ID_BASE}${n.toString(16).padStart(12, "0")}`);
const eventId = (n: number): EventId =>
  EventId.create(`${ID_BASE}${(n + 1_000).toString(16).padStart(12, "0")}`);

describe("Todo.create", () => {
  it("produces an active entity with the supplied TodoId", () => {
    const todoId = id(1);
    const { entity } = Todo.create(
      { id: todoId, eventId: eventId(1), title: "Buy milk" },
      T0,
    );
    expect(entity.status).toBe("active");
    expect(entity.id).toBe(todoId);
    expect(entity.title as unknown as string).toBe("Buy milk");
  });

  it("sets createdAt equal to updatedAt at creation time", () => {
    const { entity } = Todo.create(
      { id: id(2), eventId: eventId(2), title: "Write docs" },
      T0,
    );
    expect(entity.createdAt.getTime()).toBe(entity.updatedAt.getTime());
  });

  it("uses the provided `now` for both createdAt and updatedAt", () => {
    const { entity } = Todo.create(
      { id: id(3), eventId: eventId(3), title: "Pinned time" },
      at(123),
    );
    expect(entity.createdAt.getTime()).toBe(at(123).getTime());
    expect(entity.updatedAt.getTime()).toBe(at(123).getTime());
  });

  it("initializes version at 0", () => {
    const { entity } = Todo.create(
      { id: id(4), eventId: eventId(4), title: "Fresh" },
      T0,
    );
    expect(entity.version).toBe(0);
  });

  it("emits a single TodoCreatedEvent with matching todoId, title, occurredAt, and supplied event id", () => {
    const evId = eventId(5);
    const { entity, events } = Todo.create(
      { id: id(5), eventId: evId, title: "Buy milk" },
      at(7),
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.id).toBe(evId);
    expect(event.type).toBe("todo.created");
    if (event.type !== "todo.created") return;
    expect(event.payload.todoId).toBe(entity.id);
    expect(event.payload.title).toBe(entity.title);
    expect(event.aggregateId).toBe(entity.id);
    expect(event.occurredAt.getTime()).toBe(at(7).getTime());
  });
});

describe("Todo.complete / Todo.reopen (narrowed transitions)", () => {
  it("complete requires ActiveTodo and returns CompletedTodo", () => {
    const { entity: active } = Todo.create(
      { id: id(10), eventId: eventId(10), title: "do it" },
      T0,
    );
    const { entity: completed, events } = Todo.complete(
      active,
      eventId(11),
      at(1),
    );
    expect(completed.status).toBe("completed");
    expect(completed.version).toBe(active.version + 1);
    const event = events[0];
    if (!event || event.type !== "todo.toggled") {
      expect.fail("expected a todo.toggled event");
      return;
    }
    expect(event.payload.completed).toBe(true);
  });

  it("reopen requires CompletedTodo and returns ActiveTodo", () => {
    const { entity: active } = Todo.create(
      { id: id(20), eventId: eventId(20), title: "do it" },
      T0,
    );
    const { entity: completed } = Todo.complete(active, eventId(21), at(1));
    const { entity: reopened, events } = Todo.reopen(
      completed,
      eventId(22),
      at(2),
    );
    expect(reopened.status).toBe("active");
    expect(reopened.version).toBe(completed.version + 1);
    const event = events[0];
    if (!event || event.type !== "todo.toggled") {
      expect.fail("expected a todo.toggled event");
      return;
    }
    expect(event.payload.completed).toBe(false);
  });

  it("complete then reopen returns to the original status", () => {
    const { entity: active } = Todo.create(
      { id: id(30), eventId: eventId(30), title: "round trip" },
      T0,
    );
    const { entity: completed } = Todo.complete(active, eventId(31), at(1));
    const { entity: reopened } = Todo.reopen(completed, eventId(32), at(2));
    expect(reopened.status).toBe(active.status);
    // Each transition bumps version by 1 — round-trip lands at version 2.
    expect(reopened.version).toBe(active.version + 2);
  });
});

describe("Todo type guards", () => {
  it("isActive / isCompleted narrow correctly", () => {
    const { entity: active } = Todo.create(
      { id: id(40), eventId: eventId(40), title: "guards" },
      T0,
    );
    expect(Todo.isActive(active)).toBe(true);
    expect(Todo.isCompleted(active)).toBe(false);

    const { entity: completed } = Todo.complete(active, eventId(41), at(1));
    expect(Todo.isActive(completed)).toBe(false);
    expect(Todo.isCompleted(completed)).toBe(true);
  });
});

describe("Todo.rename", () => {
  it("updates the title and advances updatedAt with a TodoRenamedEvent", () => {
    const { entity: original } = Todo.create(
      { id: id(50), eventId: eventId(50), title: "Old name" },
      T0,
    );
    const renameEventId = eventId(51);
    const { entity: next, events } = Todo.rename(
      original,
      "New",
      renameEventId,
      at(2),
    );

    expect(next.title as unknown as string).toBe("New");
    expect(next.id).toBe(original.id);
    expect(next.createdAt.getTime()).toBe(original.createdAt.getTime());
    expect(next.updatedAt.getTime()).toBeGreaterThan(
      original.updatedAt.getTime(),
    );

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.id).toBe(renameEventId);
    expect(event.type).toBe("todo.renamed");
    if (event.type !== "todo.renamed") return;
    expect(event.payload.todoId).toBe(original.id);
    expect(event.payload.title).toBe(next.title);
  });

  it("increments version by 1 when the title actually changes", () => {
    const { entity: original } = Todo.create(
      { id: id(60), eventId: eventId(60), title: "Before" },
      T0,
    );
    const { entity: next } = Todo.rename(original, "After", eventId(61), at(1));
    expect(next.version).toBe(original.version + 1);
  });

  it("is idempotent when the new title equals the current title (after normalization)", () => {
    const { entity: original } = Todo.create(
      { id: id(70), eventId: eventId(70), title: "Stable" },
      T0,
    );
    // Even when called with a later "now", the no-op renaming must return
    // the same instance and not advance updatedAt — that's the contract that
    // protects against spurious outbox traffic.
    const { entity: same, events } = Todo.rename(
      original,
      "  Stable  ",
      eventId(71),
      at(5),
    );

    expect(same).toBe(original);
    expect(same.version).toBe(original.version);
    expect(same.updatedAt.getTime()).toBe(original.updatedAt.getTime());
    expect(events).toHaveLength(0);
  });

  it("preserves the status variant when renaming a completed todo", () => {
    const { entity: active } = Todo.create(
      { id: id(80), eventId: eventId(80), title: "A" },
      T0,
    );
    const { entity: completed } = Todo.complete(active, eventId(81), at(1));
    const { entity: renamed } = Todo.rename(completed, "B", eventId(82), at(2));
    // At the type level `renamed` is inferred as CompletedTodo via the
    // generic signature; at runtime `status` is unchanged.
    expect(renamed.status).toBe("completed");
    expect(renamed.title as unknown as string).toBe("B");
  });

  // Locks in the "validate before idempotency" ordering: an invalid title is
  // malformed input, not a no-op, so it must throw even when the current
  // title is valid. Reversing the order (compare raw input first) would let
  // malformed-but-equal inputs silently short-circuit.
  it("throws BusinessRuleError(TitleEmpty) for invalid new title even when current title is valid", () => {
    const { entity: original } = Todo.create(
      { id: id(90), eventId: eventId(90), title: "valid" },
      T0,
    );
    try {
      Todo.rename(original, "   ", eventId(91), at(1));
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.TitleEmpty);
      }
    }
  });
});
