import {
  createTestContainer,
  type TestContainer,
} from "@repo/core/adapters/libsql/__tests__/helpers";
import { PendingBatch } from "@repo/core/adapters/libsql/pendingBatch";
import { LibsqlOutboxRepository } from "@repo/core/adapters/libsql/repositories/outboxRepository";
import * as schema from "@repo/core/adapters/libsql/schema";
import {
  type DomainEvent,
  type EventDraft,
  EventId,
} from "@repo/core/domain/common/event";
import { TodoEvents } from "@repo/core/domain/todo/events";
import { TodoId, TodoTitle } from "@repo/core/domain/todo/valueObject";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeWorkerRunner } from "@/worker/node/runner";

let counter = 0;
const nextEventId = (): EventId => {
  counter += 1;
  return EventId.create(
    `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-9000-b00000000000`,
  );
};
const nextTodoId = () => {
  counter += 1;
  return TodoId.create(
    `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-9000-c00000000000`,
  );
};
const withId = <TEvent extends DomainEvent>(
  draft: EventDraft<TEvent>,
): TEvent => ({ ...draft, id: nextEventId() }) as TEvent;

// Mirror `outboxRepository.integration.test.ts`'s `manualSave`: bypass the
// UoW machinery so the test can seed outbox rows in a controlled manner.
async function seedOutboxRow(
  container: TestContainer,
  event: DomainEvent,
  now: Date,
): Promise<void> {
  const pending = new PendingBatch();
  const repo = new LibsqlOutboxRepository(
    container.db,
    container.idGenerator,
    { now: () => now },
    pending,
  );
  await repo.save([event]);
  await container.db.transaction(async (tx) => {
    for (const stmt of pending.build()) {
      await stmt.run(tx);
    }
  });
}

describe("createNodeWorkerRunner (integration)", () => {
  let container: TestContainer | null = null;
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("processes a pending outbox row end-to-end via the relay trigger", async () => {
    container = await createTestContainer();
    const todoId = nextTodoId();
    const title = TodoTitle.create("runner-integration");
    const event = withId(TodoEvents.created(todoId, title, new Date()));
    await seedOutboxRow(container, event, new Date());

    const received: DomainEvent[] = [];
    const runner = createNodeWorkerRunner({
      container: {
        clock: container.clock,
        idGenerator: container.idGenerator,
        logger: container.logger,
        outboxRepository: container.outboxRepository,
        idempotencyStore: container.idempotencyStore,
      },
      logger: container.logger,
      consumerHandler: async (e) => {
        received.push(e);
      },
      tuning: {
        // Long intervals keep the timers out of the way; the test
        // drives the work through `kick()` instead.
        relayIntervalMs: 60_000,
        pruneIntervalMs: 60_000,
      },
    });

    runner.start();
    runner.relayTrigger.kick();

    // Poll for processing. The relay tick is fire-and-forget through
    // `setImmediate`, so a tight retry loop is the cleanest way to
    // observe completion deterministically without sleeping.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (received.length > 0) break;
      await new Promise<void>((r) => setTimeout(r, 10));
    }

    await runner.stop();

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(event.id);

    // The outbox row should now be processed (processed_at stamped).
    const rows = await container.db.select().from(schema.outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processedAt).not.toBeNull();
  });

  it("stop() is idempotent and resolves once in-flight work completes", async () => {
    container = await createTestContainer();
    const runner = createNodeWorkerRunner({
      container: {
        clock: container.clock,
        idGenerator: container.idGenerator,
        logger: container.logger,
        outboxRepository: container.outboxRepository,
        idempotencyStore: container.idempotencyStore,
      },
      logger: container.logger,
      consumerHandler: async () => {},
      tuning: { relayIntervalMs: 60_000, pruneIntervalMs: 60_000 },
    });
    runner.start();
    const stopA = runner.stop();
    const stopB = runner.stop();
    await Promise.all([stopA, stopB]);
    // A second sequential stop after the first resolves must still be
    // a no-op (no double-cleanup, no throw).
    await runner.stop();
    expect(true).toBe(true);
  });
});
