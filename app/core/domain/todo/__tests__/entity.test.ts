import { describe, expect, it } from "vitest";
import { isBusinessRuleError } from "@/core/domain/error";
import { Todo } from "../entity";
import { TodoErrorCode } from "../errorCode";
import { TodoId } from "../valueObject";

describe("Todo.create", () => {
  it("produces an active entity with a valid TodoId", () => {
    const { entity } = Todo.create({ title: "Buy milk" });
    expect(entity.status).toBe("active");
    // Should not throw — round-trips through the validating constructor.
    expect(() => TodoId.create(entity.id)).not.toThrow();
    expect(entity.title as unknown as string).toBe("Buy milk");
  });

  it("sets createdAt equal to updatedAt at creation time", () => {
    const { entity } = Todo.create({ title: "Write docs" });
    expect(entity.createdAt.getTime()).toBe(entity.updatedAt.getTime());
  });

  it("satisfies updatedAt >= createdAt as an invariant", () => {
    const { entity } = Todo.create({ title: "Invariant" });
    expect(entity.updatedAt.getTime()).toBeGreaterThanOrEqual(
      entity.createdAt.getTime(),
    );
  });

  it("initializes version at 0", () => {
    const { entity } = Todo.create({ title: "Fresh" });
    expect(entity.version).toBe(0);
  });

  it("emits a single TodoCreatedEvent with matching todoId and title", () => {
    const { entity, events } = Todo.create({ title: "Buy milk" });
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.type).toBe("todo.created");
    if (event.type !== "todo.created") return;
    expect(event.payload.todoId).toBe(entity.id);
    expect(event.payload.title).toBe(entity.title);
    expect(event.aggregateId).toBe(entity.id);
  });
});

describe("Todo.toggle", () => {
  it("flips active → completed and emits TodoToggledEvent(completed=true)", async () => {
    const { entity: original } = Todo.create({ title: "Buy milk" });
    // Ensure a measurable time gap for updatedAt monotonicity.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const { entity: next, events } = Todo.toggle(original);

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
    const { entity: active } = Todo.create({ title: "Buy milk" });
    const { entity: completed } = Todo.complete(active);
    const { entity: reopened, events } = Todo.toggle(completed);

    expect(reopened.status).toBe("active");
    const event = events[0];
    if (!event || event.type !== "todo.toggled") {
      expect.fail("expected a todo.toggled event");
      return;
    }
    expect(event.payload.completed).toBe(false);
  });

  it("increments version by 1", () => {
    const { entity: original } = Todo.create({ title: "versioned" });
    const { entity: toggled } = Todo.toggle(original);
    expect(toggled.version).toBe(original.version + 1);
  });
});

describe("Todo.complete / Todo.reopen (narrowed transitions)", () => {
  it("complete requires ActiveTodo and returns CompletedTodo", () => {
    const { entity: active } = Todo.create({ title: "do it" });
    const { entity: completed, events } = Todo.complete(active);
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
    const { entity: active } = Todo.create({ title: "do it" });
    const { entity: completed } = Todo.complete(active);
    const { entity: reopened, events } = Todo.reopen(completed);
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
    const { entity: active } = Todo.create({ title: "guards" });
    expect(Todo.isActive(active)).toBe(true);
    expect(Todo.isCompleted(active)).toBe(false);

    const { entity: completed } = Todo.complete(active);
    expect(Todo.isActive(completed)).toBe(false);
    expect(Todo.isCompleted(completed)).toBe(true);
  });

  it("match dispatches to the correct branch", () => {
    const { entity: active } = Todo.create({ title: "matching" });
    const label = Todo.match(active, {
      active: () => "A",
      completed: () => "C",
    });
    expect(label).toBe("A");

    const { entity: completed } = Todo.complete(active);
    const label2 = Todo.match(completed, {
      active: () => "A",
      completed: () => "C",
    });
    expect(label2).toBe("C");
  });
});

describe("Todo.rename", () => {
  it("updates the title and advances updatedAt with a TodoRenamedEvent", async () => {
    const { entity: original } = Todo.create({ title: "Old name" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const { entity: next, events } = Todo.rename(original, "New");

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
    const { entity: original } = Todo.create({ title: "Before" });
    const { entity: next } = Todo.rename(original, "After");
    expect(next.version).toBe(original.version + 1);
  });

  it("is idempotent when the new title equals the current title (after normalization)", async () => {
    const { entity: original } = Todo.create({ title: "Stable" });
    // Wait so that a naive implementation would produce a different updatedAt.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Supply the same title with extra surrounding whitespace: after trim it
    // normalizes to the same value.
    const { entity: same, events } = Todo.rename(original, "  Stable  ");

    expect(same).toBe(original);
    expect(same.version).toBe(original.version);
    expect(same.updatedAt.getTime()).toBe(original.updatedAt.getTime());
    expect(events).toHaveLength(0);
  });

  it("preserves the status variant when renaming a completed todo", () => {
    const { entity: active } = Todo.create({ title: "A" });
    const { entity: completed } = Todo.complete(active);
    const { entity: renamed } = Todo.rename(completed, "B");
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
    const { entity: original } = Todo.create({ title: "valid" });
    try {
      Todo.rename(original, "   ");
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
    const { entity } = Todo.create({ title: "To delete" });
    const { entity: next, events } = Todo.delete(entity);

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
  });
});
