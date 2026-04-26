import { eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FakeIdGenerator } from "@/core/application/__tests__/fakes";
import { setupTestContainer } from "@/core/application/__tests__/helpers";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import * as schema from "../schema";

/**
 * Integration tests for the Drizzle outbox repository.
 *
 * Covers the invariants a fake cannot faithfully reproduce:
 *
 * - Column-level placement of `event_type`, `aggregate_id`, `payload` at
 *   write time.
 * - `listPending` skips already-processed rows and returns FIFO order.
 * - `markProcessed` only updates pending rows.
 *
 * Ids are minted from a `FakeIdGenerator` so the tests stay deterministic
 * (same id sequence across runs) — the domain layer no longer ships a
 * `TodoId.generate()`, ids come from the application port.
 */

const ids = new FakeIdGenerator();
const nextId = (): string => ids.next();
const nextTodoId = () => TodoId.create(nextId());

describe("DrizzleSqliteOutboxRepository.save (integration)", () => {
  const getContainer = setupTestContainer();

  it("writes payload / eventType / aggregateId to the correct columns", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("persistence");
    const event = TodoEvents.created(nextId(), todoId, title, new Date());

    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([event]);
    });

    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) return;
    expect(row.id).toBe(event.id);
    expect(row.eventType).toBe("todo.created");
    expect(row.aggregateId).toBe(todoId);
    expect(Math.floor(row.occurredAt.getTime() / 1000)).toBe(
      Math.floor(event.occurredAt.getTime() / 1000),
    );
    expect(row.processedAt).toBeNull();

    const stored = row.payload as { todoId: string; title: string };
    expect(stored.todoId).toBe(todoId);
    expect(stored.title).toBe(title);
  });
});

describe("DrizzleSqliteOutboxRepository.listPending (integration)", () => {
  const getContainer = setupTestContainer();

  it("returns only unprocessed entries in FIFO order", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("claim");
    const a = TodoEvents.created(nextId(), todoId, title, new Date(0));
    const b = TodoEvents.toggled(nextId(), todoId, true, new Date(1000));
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([a, b]);
    });

    // Mark the first one as already processed — it must NOT be re-listed.
    await container.db
      .update(schema.outboxEvents)
      .set({ processedAt: new Date() })
      .where(eq(schema.outboxEvents.id, a.id));

    const pending = await container.outboxRepository.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(b.id);
  });

  it("returns rows in insertion order when occurredAt is identical", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("ordered");
    const sameTime = new Date(0);
    const a = TodoEvents.created(nextId(), todoId, title, sameTime);
    const b = TodoEvents.toggled(nextId(), todoId, true, sameTime);
    const c = TodoEvents.deleted(nextId(), todoId, sameTime);
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([a, b, c]);
    });

    const pending = await container.outboxRepository.listPending(10);
    // FakeIdGenerator hands out monotonically increasing ids, so insertion
    // order is preserved by the (createdAt, id) ordering even when
    // occurredAt ties.
    expect(pending.map((entry) => entry.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe("DrizzleSqliteOutboxRepository.markProcessed (integration)", () => {
  const getContainer = setupTestContainer();

  it("only marks the given ids and stamps processedAt", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("scoped-mark");
    const a = TodoEvents.created(nextId(), todoId, title, new Date());
    const b = TodoEvents.toggled(nextId(), todoId, true, new Date());
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([a, b]);
    });

    const now = new Date();
    await container.outboxRepository.markProcessed([b.id], now);

    const rows = await container.db.select().from(schema.outboxEvents);
    const aRow = rows.find((r) => r.id === a.id);
    const bRow = rows.find((r) => r.id === b.id);
    expect(aRow?.processedAt).toBeNull();
    expect(bRow?.processedAt).not.toBeNull();
  });

  it("is a no-op when `ids` is empty", async () => {
    const container = getContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("empty-mark");
    await container.unitOfWorkProvider.run(async ({ collectEvents }) => {
      collectEvents([TodoEvents.created(nextId(), todoId, title, new Date())]);
    });

    await container.outboxRepository.markProcessed([], new Date());

    const pending = await container.db
      .select()
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.processedAt));
    expect(pending).toHaveLength(1);
  });
});
