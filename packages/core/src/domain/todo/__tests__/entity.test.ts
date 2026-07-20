import {
  isBusinessRuleError,
  isRehydrationError,
} from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
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

describe("Todo.create", () => {
  it("produces an active entity with the supplied TodoId", () => {
    const todoId = id(1);
    const { entity } = Todo.create({ id: todoId, title: "Buy milk" }, T0);
    expect(entity.status).toBe("active");
    expect(entity.id).toBe(todoId);
    expect(entity.title as unknown as string).toBe("Buy milk");
  });

  it("sets createdAt equal to updatedAt at creation time", () => {
    const { entity } = Todo.create({ id: id(2), title: "Write docs" }, T0);
    expect(entity.createdAt.getTime()).toBe(entity.updatedAt.getTime());
  });

  it("uses the provided `now` for both createdAt and updatedAt", () => {
    const { entity } = Todo.create(
      { id: id(3), title: "Pinned time" },
      at(123),
    );
    expect(entity.createdAt.getTime()).toBe(at(123).getTime());
    expect(entity.updatedAt.getTime()).toBe(at(123).getTime());
  });

  it("initializes version at 0", () => {
    const { entity } = Todo.create({ id: id(4), title: "Fresh" }, T0);
    expect(entity.version).toBe(0);
  });

  it("emits a single TodoCreatedEvent draft with matching todoId, title, and occurredAt", () => {
    const { entity, eventDrafts } = Todo.create(
      { id: id(5), title: "Buy milk" },
      at(7),
    );
    expect(eventDrafts).toHaveLength(1);
    const draft = eventDrafts[0];
    expect(draft).toBeDefined();
    if (!draft) return;
    expect(draft.type).toBe("todo.created");
    if (draft.type !== "todo.created") return;
    expect(draft.payload.todoId).toBe(entity.id);
    expect(draft.payload.title).toBe(entity.title);
    expect(draft.aggregateId).toBe(entity.id);
    expect(draft.occurredAt.getTime()).toBe(at(7).getTime());
  });
});

describe("Todo.complete / Todo.reopen (narrowed transitions)", () => {
  it("complete requires ActiveTodo and returns CompletedTodo", () => {
    const { entity: active } = Todo.create({ id: id(10), title: "do it" }, T0);
    const { entity: completed, eventDrafts } = Todo.complete(active, at(1));
    expect(completed.status).toBe("completed");
    expect(completed.version).toBe(active.version + 1);
    const draft = eventDrafts[0];
    if (!draft || draft.type !== "todo.toggled") {
      expect.fail("expected a todo.toggled event");
      return;
    }
    expect(draft.payload.completed).toBe(true);
  });

  it("reopen requires CompletedTodo and returns ActiveTodo", () => {
    const { entity: active } = Todo.create({ id: id(20), title: "do it" }, T0);
    const { entity: completed } = Todo.complete(active, at(1));
    const { entity: reopened, eventDrafts } = Todo.reopen(completed, at(2));
    expect(reopened.status).toBe("active");
    expect(reopened.version).toBe(completed.version + 1);
    const draft = eventDrafts[0];
    if (!draft || draft.type !== "todo.toggled") {
      expect.fail("expected a todo.toggled event");
      return;
    }
    expect(draft.payload.completed).toBe(false);
  });

  it("complete then reopen returns to the original status", () => {
    const { entity: active } = Todo.create(
      { id: id(30), title: "round trip" },
      T0,
    );
    const { entity: completed } = Todo.complete(active, at(1));
    const { entity: reopened } = Todo.reopen(completed, at(2));
    expect(reopened.status).toBe(active.status);
    // Each transition bumps version by 1 — round-trip lands at version 2.
    expect(reopened.version).toBe(active.version + 2);
  });
});

describe("Todo type guards", () => {
  it("isActive / isCompleted narrow correctly", () => {
    const { entity: active } = Todo.create({ id: id(40), title: "guards" }, T0);
    expect(Todo.isActive(active)).toBe(true);
    expect(Todo.isCompleted(active)).toBe(false);

    const { entity: completed } = Todo.complete(active, at(1));
    expect(Todo.isActive(completed)).toBe(false);
    expect(Todo.isCompleted(completed)).toBe(true);
  });
});

describe("Todo.rename", () => {
  it("updates the title and advances updatedAt with a TodoRenamedEvent draft", () => {
    const { entity: original } = Todo.create(
      { id: id(50), title: "Old name" },
      T0,
    );
    const { entity: next, eventDrafts } = Todo.rename(original, "New", at(2));

    expect(next.title as unknown as string).toBe("New");
    expect(next.id).toBe(original.id);
    expect(next.createdAt.getTime()).toBe(original.createdAt.getTime());
    expect(next.updatedAt.getTime()).toBeGreaterThan(
      original.updatedAt.getTime(),
    );

    expect(eventDrafts).toHaveLength(1);
    const draft = eventDrafts[0];
    expect(draft).toBeDefined();
    if (!draft) return;
    expect(draft.type).toBe("todo.renamed");
    if (draft.type !== "todo.renamed") return;
    expect(draft.payload.todoId).toBe(original.id);
    expect(draft.payload.title).toBe(next.title);
  });

  it("increments version by 1 when the title actually changes", () => {
    const { entity: original } = Todo.create(
      { id: id(60), title: "Before" },
      T0,
    );
    const { entity: next } = Todo.rename(original, "After", at(1));
    expect(next.version).toBe(original.version + 1);
  });

  it("is idempotent when the new title equals the current title (after normalization)", () => {
    const { entity: original } = Todo.create(
      { id: id(70), title: "Stable" },
      T0,
    );
    // Even when called with a later "now", the no-op renaming must return
    // the same instance and not advance updatedAt — that's the contract that
    // protects against spurious outbox traffic.
    const { entity: same, eventDrafts } = Todo.rename(
      original,
      "  Stable  ",
      at(5),
    );

    expect(same).toBe(original);
    expect(same.version).toBe(original.version);
    expect(same.updatedAt.getTime()).toBe(original.updatedAt.getTime());
    expect(eventDrafts).toHaveLength(0);
  });

  it("preserves the status variant when renaming a completed todo", () => {
    const { entity: active } = Todo.create({ id: id(80), title: "A" }, T0);
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
    const { entity: original } = Todo.create(
      { id: id(90), title: "valid" },
      T0,
    );
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

describe("Todo.reconstruct", () => {
  const validRow = () => ({
    id: `${ID_BASE}${(100).toString(16).padStart(12, "0")}`,
    title: "rehydrated",
    status: "active",
    version: 3,
    createdAt: T0,
    updatedAt: at(1),
  });

  it("rebuilds an entity from a well-formed persistence row", () => {
    const row = validRow();
    const todo = Todo.reconstruct(row);
    expect(todo.id as unknown as string).toBe(row.id);
    expect(todo.title as unknown as string).toBe("rehydrated");
    expect(todo.status).toBe("active");
    expect(todo.version).toBe(3);
  });

  // Rehydration must not surface as `BusinessRuleError`: a stored row that
  // violates an invariant is a data-integrity issue, not a user-input
  // failure. Adapters depend on this distinction to translate cleanly into
  // `SystemError(DataIntegrityError)`.
  it("throws RehydrationError (not BusinessRuleError) when stored title is empty", () => {
    try {
      Todo.reconstruct({ ...validRow(), title: "   " });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isRehydrationError(error)).toBe(true);
      expect(isBusinessRuleError(error)).toBe(false);
      if (isRehydrationError(error)) {
        expect(isBusinessRuleError(error.cause)).toBe(true);
      }
    }
  });

  it("throws RehydrationError when stored status is unknown", () => {
    try {
      Todo.reconstruct({ ...validRow(), status: "archived" });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isRehydrationError(error)).toBe(true);
    }
  });

  it("throws RehydrationError when stored version is negative", () => {
    try {
      Todo.reconstruct({ ...validRow(), version: -1 });
      expect.fail("should have thrown");
    } catch (error) {
      expect(isRehydrationError(error)).toBe(true);
    }
  });
});
