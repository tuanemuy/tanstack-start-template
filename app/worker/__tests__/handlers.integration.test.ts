import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDatabase } from "@/core/adapters/d1/client";
import { PendingBatch } from "@/core/adapters/d1/pendingBatch";
import { D1OutboxRepository } from "@/core/adapters/d1/repositories/outboxRepository";
import { outboxEvents } from "@/core/adapters/d1/schema";
import {
  type DomainEvent,
  type EventDraft,
  EventId,
} from "@/core/domain/common/event";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import {
  type ConsumerEnv,
  handleQueue,
  type PrunerEnv,
  type RelayEnv,
  runPruneTick,
  runRelayTick,
} from "../handlers";

// End-to-end integration of the per-Worker handler functions against
// a real D1 binding and a real Miniflare queue. Tests target the pure
// `runRelayTick` / `runPruneTick` / `handleQueue` functions directly
// rather than going through any Worker entry — entries are 1-line
// adapters and have nothing to verify beyond their type signature.
//
// The fetch handler is intentionally not exercised; it lives in the
// main app Worker (`app/worker.ts`) and is gated on TanStack Start's
// build pipeline.

let counter = 0;
const nextEventId = (): EventId => {
  counter += 1;
  return EventId.create(
    `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-a000-400000000000`,
  );
};
const nextTodoId = () => {
  counter += 1;
  return TodoId.create(
    `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-a000-500000000000`,
  );
};
const withId = <TEvent extends DomainEvent>(
  draft: EventDraft<TEvent>,
): TEvent => ({ ...draft, id: nextEventId() }) as TEvent;

async function seedOutbox(events: readonly DomainEvent[]): Promise<void> {
  const db = getDatabase(env.DB);
  const pending = new PendingBatch(db);
  const repo = new D1OutboxRepository(
    db,
    {
      next: () => "unused",
      validate: () => true,
    },
    pending,
  );
  await repo.save(events, new Date());
  if (!pending.isEmpty()) {
    await db.batch(pending.build());
  }
}

const relayEnv = (): RelayEnv => env as unknown as RelayEnv;
const prunerEnv = (): PrunerEnv => env as unknown as PrunerEnv;
const consumerEnv = (): ConsumerEnv => env as unknown as ConsumerEnv;

describe("relay producer Worker — runRelayTick", () => {
  it("claims pending outbox rows, sends them to the queue, and marks processed", async () => {
    const todoId = nextTodoId();
    const title = TodoTitle.create("relay");
    const event = withId(TodoEvents.created(todoId, title, new Date()));
    await seedOutbox([event]);

    const result = await runRelayTick(relayEnv());
    expect(result.processed).toBe(1);

    const db = getDatabase(env.DB);
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, event.id));
    expect(rows[0]?.processedAt).not.toBeNull();
    expect(rows[0]?.attempts).toBe(0);
  });

  it("is a no-op when the outbox has no pending rows", async () => {
    const result = await runRelayTick(relayEnv());
    expect(result.processed).toBe(0);
  });
});

describe("pruner Worker — runPruneTick", () => {
  it("deletes processed rows older than the retention window", async () => {
    const todoId = nextTodoId();
    const title = TodoTitle.create("prune");
    const event = withId(TodoEvents.created(todoId, title, new Date(0)));
    await seedOutbox([event]);

    const db = getDatabase(env.DB);
    // Mark processed well before the 7-day retention window.
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .update(outboxEvents)
      .set({ processedAt: longAgo })
      .where(eq(outboxEvents.id, event.id));

    const result = await runPruneTick(prunerEnv());
    expect(result.deleted).toBe(1);

    const remaining = await db.select().from(outboxEvents);
    expect(remaining).toHaveLength(0);
  });

  it("retains processed rows newer than the retention window", async () => {
    const todoId = nextTodoId();
    const title = TodoTitle.create("recent");
    const event = withId(TodoEvents.created(todoId, title, new Date()));
    await seedOutbox([event]);

    const db = getDatabase(env.DB);
    const recent = new Date(Date.now() - 60 * 1000); // 1 min ago
    await db
      .update(outboxEvents)
      .set({ processedAt: recent })
      .where(eq(outboxEvents.id, event.id));

    const result = await runPruneTick(prunerEnv());
    expect(result.deleted).toBe(0);

    const remaining = await db.select().from(outboxEvents);
    expect(remaining).toHaveLength(1);
  });
});

describe("consumer Worker — handleQueue", () => {
  it("acks every message in the batch on the happy path", async () => {
    const todoId = nextTodoId();
    const title = TodoTitle.create("queue-ack");
    const event = withId(TodoEvents.created(todoId, title, new Date()));

    const batch = createMessageBatch<DomainEvent>(
      "tanstack-start-template-events",
      [
        {
          id: "msg-1",
          timestamp: new Date(),
          body: event,
          attempts: 1,
        },
      ],
    );
    const ctx = createExecutionContext();
    await handleQueue(batch, consumerEnv(), ctx);
    const result = await getQueueResult(batch, ctx);

    // Default disposition + no explicit retries = every message acked.
    expect(result.retryBatch.retry).toBe(false);
  });
});
