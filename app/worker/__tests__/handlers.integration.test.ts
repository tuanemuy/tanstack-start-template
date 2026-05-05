import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDatabase } from "@/core/adapters/d1/client";
import { D1OutboxRepository } from "@/core/adapters/d1/repositories/outboxRepository";
import { PendingBatch } from "@/core/adapters/d1/pendingBatch";
import { outboxEvents } from "@/core/adapters/d1/schema";
import {
  type DomainEvent,
  type EventDraft,
  EventId,
} from "@/core/domain/common/event";
import { TodoEvents } from "@/core/domain/todo/events";
import { TodoId, TodoTitle } from "@/core/domain/todo/valueObject";
import {
  handleQueue,
  handleScheduled,
  PRUNE_CRON,
  RELAY_CRON,
  type WorkerEnv,
} from "../handlers";

// End-to-end integration of the Workers handlers against a real D1
// binding and a real Miniflare queue. The relay tick claims rows from
// the DB, posts them onto `EVENTS_QUEUE`, and marks the rows
// processed; the queue consumer drains messages and acks them. The
// fetch handler is intentionally NOT exercised here — its
// TanStack Start dependency would require booting the full RSC graph,
// which is the wrong layer to validate from a worker integration test.

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

const workerEnv = (): WorkerEnv => env as unknown as WorkerEnv;

describe("worker scheduled handler — relay cron", () => {
  it("claims pending outbox rows, sends them to the queue, and marks processed", async () => {
    const todoId = nextTodoId();
    const title = TodoTitle.create("relay");
    const event = withId(TodoEvents.created(todoId, title, new Date()));
    await seedOutbox([event]);

    const controller = createScheduledController({ cron: RELAY_CRON });
    const ctx = createExecutionContext();
    await handleScheduled(controller, workerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const db = getDatabase(env.DB);
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, event.id));
    expect(rows[0]?.processedAt).not.toBeNull();
    expect(rows[0]?.attempts).toBe(0);
  });

  it("is a no-op when the outbox has no pending rows", async () => {
    const controller = createScheduledController({ cron: RELAY_CRON });
    const ctx = createExecutionContext();
    await handleScheduled(controller, workerEnv(), ctx);
    await waitOnExecutionContext(ctx);
    // No assertion beyond "did not throw"; the relay logic itself is
    // covered by the application-layer unit tests.
  });
});

describe("worker scheduled handler — prune cron", () => {
  it("deletes processed rows older than the retention window", async () => {
    const todoId = nextTodoId();
    const title = TodoTitle.create("prune");
    const event = withId(TodoEvents.created(todoId, title, new Date(0)));
    await seedOutbox([event]);

    const db = getDatabase(env.DB);
    // Mark it processed well before the 7-day retention window.
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .update(outboxEvents)
      .set({ processedAt: longAgo })
      .where(eq(outboxEvents.id, event.id));

    const controller = createScheduledController({ cron: PRUNE_CRON });
    const ctx = createExecutionContext();
    await handleScheduled(controller, workerEnv(), ctx);
    await waitOnExecutionContext(ctx);

    const remaining = await db.select().from(outboxEvents);
    expect(remaining).toHaveLength(0);
  });
});

describe("worker queue handler", () => {
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
    await handleQueue(batch, workerEnv(), ctx);
    const result = await getQueueResult(batch, ctx);

    // Default disposition + no explicit retries = every message acked.
    // `retryBatch.retry` is true only if `retryAll()` was invoked or
    // if individual messages were retried; here we expect neither.
    expect(result.retryBatch.retry).toBe(false);
  });
});
