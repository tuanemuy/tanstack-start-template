import { describe, expect, it } from "vitest";
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

describe("Todo.create", () => {
  it("produces an active entity with a valid TodoId", () => {
    const { entity } = Todo.create({ title: "Buy milk" }, T0);
    expect(entity.status).toBe("active");
    // Should not throw — round-trips through the validating constructor.
    expect(() => TodoId.create(entity.id)).not.toThrow();
    expect(entity.title as unknown as string).toBe("Buy milk");
  });

  it("sets createdAt equal to updatedAt at creation time", () => {
    const { entity } = Todo.create({ title: "Write docs" }, T0);
    expect(entity.createdAt.getTime()).toBe(entity.updatedAt.getTime());
  });

  it("uses the provided `now` for both createdAt and updatedAt", () => {
    const { entity } = Todo.create({ title: "Pinned time" }, at(123));
    expect(entity.createdAt.getTime()).toBe(at(123).getTime());
    expect(entity.updatedAt.getTime()).toBe(at(123).getTime());
  });

  it("initializes version at 0", () => {
    const { entity } = Todo.create({ title: "Fresh" }, T0);
    expect(entity.version).toBe(0);
  });

  it("emits a single TodoCreatedEvent with matching todoId, title and occurredAt", () => {
    const { entity, events } = Todo.create({ title: "Buy milk" }, at(7));
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.type).toBe("todo.created");
    if (event.type !== "todo.created") return;
    expect(event.payload.todoId).toBe(entity.id);
    expect(event.payload.title).toBe(entity.title);
    expect(event.aggregateId).toBe(entity.id);
    expect(event.occurredAt.getTime()).toBe(at(7).getTime());
  });
});

describe("Todo.toggle", () => {
  it("flips active → completed and emits TodoToggledEvent(completed=true)", () => {
    const { entity: original } = Todo.create({ title: "Buy milk" }, T0);
    const { entity: next, events } = Todo.toggle(original, at(2));

    expect(original.status).toBe("active");
    expect(next.status).toBe("completed");
    expect(next.id).toBe(original.id);
    expect(next.updatedAt.getTime()).toBeGreaterThan(
      original.updatedAt.getTime(),
    );

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.type).toBe("todo.toggled");
    if (event.type !== "todo.toggled") return;
    expect(event.payload.todoId).toBe(original.id);
    expect(event.payload.completed).toBe(true);
  });

  it("flips completed → active and emits TodoToggledEvent(completed=false)", () => {
    const { entity: active } = Todo.create({ title: "Buy milk" }, T0);
    const { entity: completed } = Todo.complete(active, at(1));
    const { entity: reopened, events } = Todo.toggle(completed, at(2));

    expect(reopened.status).toBe("active");
    const event = events[0];
    if (!event || event.type !== "todo.toggled") {
      expect.fail("expected a todo.toggled event");
      return;
    }
    expect(event.payload.completed).toBe(false);
  });

  it("increments version by 1", () => {
    const { entity: original } = Todo.create({ title: "versioned" }, T0);
    const { entity: toggled } = Todo.toggle(original, at(1));
    expect(toggled.version).toBe(original.version + 1);
  });
});

describe("Todo.complete / Todo.reopen (narrowed transitions)", () => {
  it("complete requires ActiveTodo and returns CompletedTodo", () => {
    const { entity: active } = Todo.create({ title: "do it" }, T0);
    const { entity: completed, events } = Todo.complete(active, at(1));
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
    const { entity: active } = Todo.create({ title: "do it" }, T0);
    const { entity: completed } = Todo.complete(active, at(1));
    const { entity: reopened, events } = Todo.reopen(completed, at(2));
    expect(reopened.status).toBe("active");
    expect(reopened.version).toBe(completed.version + 1);
    const event = events[0];
    if (!event || event.type !== "todo.toggled") {
      expect.fail("expected a todo.toggled event");
      return;
    }
    expect(event.payload.completed).toBe(false);
  });
});

describe("Todo type guards and match", () => {
  it("isActive / isCompleted narrow correctly", () => {
    const { entity: active } = Todo.create({ title: "guards" }, T0);
    expect(Todo.isActive(active)).toBe(true);
    expect(Todo.isCompleted(active)).toBe(false);

    const { entity: completed } = Todo.complete(active, at(1));
    expect(Todo.isActive(completed)).toBe(false);
    expect(Todo.isCompleted(completed)).toBe(true);
  });

  it("match dispatches to the correct branch", () => {
    const { entity: active } = Todo.create({ title: "matching" }, T0);
    const label = Todo.match(active, {
      active: () => "A",
      completed: () => "C",
    });
    expect(label).toBe("A");

    const { entity: completed } = Todo.complete(active, at(1));
    const label2 = Todo.match(completed, {
      active: () => "A",
      completed: () => "C",
    });
    expect(label2).toBe("C");
  });
});

describe("Todo.rename", () => {
  it("updates the title and advances updatedAt with a TodoRenamedEvent", () => {
    const { entity: original } = Todo.create({ title: "Old name" }, T0);
    const { entity: next, events } = Todo.rename(original, "New", at(2));

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
    expect(event.type).toBe("todo.renamed");
    if (event.type !== "todo.renamed") return;
    expect(event.payload.todoId).toBe(original.id);
    expect(event.payload.title).toBe(next.title);
  });

  it("increments version by 1 when the title actually changes", () => {
    const { entity: original } = Todo.create({ title: "Before" }, T0);
    const { entity: next } = Todo.rename(original, "After", at(1));
    expect(next.version).toBe(original.version + 1);
  });

  it("is idempotent when the new title equals the current title (after normalization)", () => {
    const { entity: original } = Todo.create({ title: "Stable" }, T0);
    // Even when called with a later "now", the no-op renaming must return
    // the same instance and not advance updatedAt — that's the contract that
    // protects against spurious outbox traffic.
    const { entity: same, events } = Todo.rename(original, "  Stable  ", at(5));

    expect(same).toBe(original);
    expect(same.version).toBe(original.version);
    expect(same.updatedAt.getTime()).toBe(original.updatedAt.getTime());
    expect(events).toHaveLength(0);
  });

  it("preserves the status variant when renaming a completed todo", () => {
    const { entity: active } = Todo.create({ title: "A" }, T0);
    const { entity: completed } = Todo.complete(active, at(1));
    const { entity: renamed } = Todo.rename(completed, "B", at(2));
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
    const { entity: original } = Todo.create({ title: "valid" }, T0);
    try {
      Todo.rename(original, "   ", at(1));
      expect.fail("should have thrown");
    } catch (error) {
      expect(isBusinessRuleError(error)).toBe(true);
      if (isBusinessRuleError(error)) {
        expect(error.code).toBe(TodoErrorCode.TitleEmpty);
      }
    }
  });
});

describe("Todo.delete", () => {
  it("returns WithEvents<null, …> with a single TodoDeletedEvent", () => {
    const { entity } = Todo.create({ title: "To delete" }, T0);
    const { entity: next, events } = Todo.delete(entity, at(1));

    // Delete is terminal — no successor entity.
    expect(next).toBeNull();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.type).toBe("todo.deleted");
    if (event.type !== "todo.deleted") return;
    expect(event.payload.todoId).toBe(entity.id);
    expect(event.aggregateId).toBe(entity.id);
    expect(event.occurredAt.getTime()).toBe(at(1).getTime());
  });
});
