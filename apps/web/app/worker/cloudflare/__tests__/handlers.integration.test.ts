import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { getDatabase } from "@repo/core/adapters/d1/client";
import { PendingBatch } from "@repo/core/adapters/d1/pendingBatch";
import { D1IdempotencyStore } from "@repo/core/adapters/d1/repositories/idempotencyStore";
import { D1OutboxRepository } from "@repo/core/adapters/d1/repositories/outboxRepository";
import { outboxEvents, processedEvents } from "@repo/core/adapters/d1/schema";
import {
  type DomainEvent,
  type EventDraft,
  EventId,
} from "@repo/core/domain/common/event";
import { TodoEvents } from "@repo/core/domain/todo/events";
import { TodoId, TodoTitle } from "@repo/core/domain/todo/valueObject";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConsumerEnv,
  type DlqEnv,
  handleDlq,
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
// main app Worker (`apps/web/app/server.cloudflare.ts`) and is gated on TanStack Start's
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
    { now: () => new Date() },
    pending,
  );
  await repo.save(events);
  if (!pending.isEmpty()) {
    await db.batch(pending.build());
  }
}

const relayEnv = (): RelayEnv => env as unknown as RelayEnv;
const prunerEnv = (): PrunerEnv => env as unknown as PrunerEnv;
const consumerEnv = (): ConsumerEnv => env as unknown as ConsumerEnv;
const dlqEnv = (): DlqEnv => env as unknown as DlqEnv;

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

afterEach(() => {
  vi.restoreAllMocks();
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

    // The first delivery must have stamped a `processed_events` row so
    // a redelivery is recognised as a duplicate.
    const db = getDatabase(env.DB);
    const rows = await db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.id, event.id));
    expect(rows).toHaveLength(1);
  });

  it("acks a redelivered message without re-running the handler", async () => {
    const todoId = nextTodoId();
    const title = TodoTitle.create("queue-redeliver");
    const event = withId(TodoEvents.created(todoId, title, new Date()));

    // First delivery — stamps `processed_events`.
    const firstBatch = createMessageBatch<DomainEvent>(
      "tanstack-start-template-events",
      [
        {
          id: "msg-redeliver-1",
          timestamp: new Date(),
          body: event,
          attempts: 1,
        },
      ],
    );
    const firstCtx = createExecutionContext();
    await handleQueue(firstBatch, consumerEnv(), firstCtx);
    await getQueueResult(firstBatch, firstCtx);

    const db = getDatabase(env.DB);
    const stamped = await db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.id, event.id));
    expect(stamped).toHaveLength(1);
    const firstStampedAt = stamped[0]?.processedAt;

    // Second delivery (queue redelivery) — must be acked, must not
    // overwrite the original stamp's timestamp.
    const secondBatch = createMessageBatch<DomainEvent>(
      "tanstack-start-template-events",
      [
        {
          id: "msg-redeliver-2",
          timestamp: new Date(),
          body: event,
          attempts: 2,
        },
      ],
    );
    const secondCtx = createExecutionContext();
    await handleQueue(secondBatch, consumerEnv(), secondCtx);
    const secondResult = await getQueueResult(secondBatch, secondCtx);

    expect(secondResult.retryBatch.retry).toBe(false);

    const stampedAgain = await db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.id, event.id));
    expect(stampedAgain).toHaveLength(1);
    expect(stampedAgain[0]?.processedAt?.getTime()).toBe(
      firstStampedAt?.getTime(),
    );
  });
});

// Production DLQ routing is configured on the queue itself (see
// `wrangler.toml [[env.consumer.queues.consumers]] dead_letter_queue`
// and the matching `queueConsumers` block in
// `vitest.config.integration.ts`). What the handler controls is the
// per-message disposition that drives that routing — `retry()` after
// `max_retries` is what causes a message to land on the DLQ. The test
// below verifies that signal at the handler level; the queue-system
// transition from exhausted retries to DLQ is exercised by the config
// parity between the test miniflare setup and wrangler.toml.
describe("consumer Worker — handleQueue retry path", () => {
  it("routes failed messages to retry() so the queue can dead-letter them", async () => {
    const okTodo = nextTodoId();
    const okEvent = withId(
      TodoEvents.created(okTodo, TodoTitle.create("ok"), new Date()),
    );
    const failTodo = nextTodoId();
    const failEvent = withId(
      TodoEvents.created(failTodo, TodoTitle.create("fail"), new Date()),
    );

    const originalMarkProcessed = D1IdempotencyStore.prototype.markProcessed;
    vi.spyOn(D1IdempotencyStore.prototype, "markProcessed").mockImplementation(
      async function (this: D1IdempotencyStore, id) {
        if (id === failEvent.id) {
          throw new Error("simulated subscriber failure");
        }
        return await originalMarkProcessed.call(this, id);
      },
    );

    const batch = createMessageBatch<DomainEvent>(
      "tanstack-start-template-events",
      [
        {
          id: "msg-ok",
          timestamp: new Date(),
          body: okEvent,
          attempts: 1,
        },
        {
          id: "msg-fail",
          timestamp: new Date(),
          body: failEvent,
          attempts: 1,
        },
      ],
    );
    const ctx = createExecutionContext();
    await handleQueue(batch, consumerEnv(), ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toContain("msg-ok");
    expect(result.explicitAcks).not.toContain("msg-fail");
    // Per-message `message.retry()` shows up in `retryMessages` (the
    // batch-wide `retryBatch.retry` flag is only set by
    // `batch.retryAll()`). Either path eventually exhausts
    // `max_retries` and routes the message to the DLQ.
    expect(
      result.retryMessages.map((m: { msgId: string }) => m.msgId),
    ).toContain("msg-fail");

    // The successful message must still have been stamped — partial
    // failure inside the batch does not roll back sibling writes.
    const db = getDatabase(env.DB);
    const okRows = await db
      .select()
      .from(processedEvents)
      .where(eq(processedEvents.id, okEvent.id));
    expect(okRows).toHaveLength(1);
  });
});

describe("DLQ Worker — handleDlq", () => {
  it("acks every quarantined message so it does not re-enter the DLQ", async () => {
    const todoId = nextTodoId();
    const title = TodoTitle.create("dlq-ack");
    const event = withId(TodoEvents.created(todoId, title, new Date()));

    const batch = createMessageBatch<DomainEvent>(
      "tanstack-start-template-events-dlq",
      [
        {
          id: "dlq-msg-1",
          timestamp: new Date(),
          body: event,
          attempts: 4,
        },
      ],
    );
    const ctx = createExecutionContext();
    await handleDlq(batch, dlqEnv(), ctx);
    const result = await getQueueResult(batch, ctx);

    // The DLQ has no further dead-letter target — re-failure would
    // loop, so every message must be acked even on the surfacing path.
    expect(result.retryBatch.retry).toBe(false);
  });
});
