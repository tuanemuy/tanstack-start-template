import type { Client } from "@libsql/client";
import { isSystemError } from "@repo/core/application/errors";
import { EventId } from "@repo/core/domain/common/event";
import { Todo } from "@repo/core/domain/todo/entity";
import { afterEach, describe, expect, it } from "vitest";
import { createLibsqlClient } from "../client";
import * as schema from "../schema";
import { createTestContainer, type TestContainer } from "./helpers";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function insertOne(c: TestContainer, title: string): Promise<void> {
  const { entity, eventDrafts } = Todo.create(
    { id: c.idGenerator.next(), title },
    NOW,
  );
  return c.unitOfWorkProvider.run(async ({ todoRepository, collectEvents }) => {
    await todoRepository.insert(entity);
    collectEvents(eventDrafts);
  });
}

async function busyTimeout(c: TestContainer): Promise<unknown> {
  const result = await c.client.execute("PRAGMA busy_timeout");
  return Object.values(result.rows[0] ?? {})[0];
}

const statuses = (results: readonly PromiseSettledResult<unknown>[]) =>
  results.map((r) => r.status);

describe("libSQL write contention (integration)", () => {
  let container: TestContainer | null = null;
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("keeps busy_timeout after a unit of work", async () => {
    container = await createTestContainer();
    expect(await busyTimeout(container)).toBe(5000);
    await insertOne(container, "one");
    expect(await busyTimeout(container)).toBe(5000);
  });

  it("commits every unit of work of a concurrent burst, and the ones right after it", async () => {
    container = await createTestContainer();
    const c = container;
    for (let round = 0; round < 20; round++) {
      const results = await Promise.allSettled(
        ["a", "b", "c"].map((title) => insertOne(c, `${title}-${round}`)),
      );
      expect(statuses(results)).toEqual([
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ]);
    }
    for (let i = 0; i < 10; i++) {
      await insertOne(c, `after-${i}`);
    }
    expect(await c.db.select().from(schema.todos)).toHaveLength(70);
  });

  it("commits units of work racing the worker-side writes", async () => {
    container = await createTestContainer();
    const c = container;
    for (let i = 0; i < 5; i++) {
      await insertOne(c, `seed-${i}`);
    }

    const relayTick = async () => {
      const claimed = await c.outboxRepository.claimPending({
        limit: 2,
        now: NOW,
        workerId: "relay",
        leaseMs: 30_000,
      });
      const [failed, ...processed] = claimed.map((entry) =>
        EventId.create(entry.id),
      );
      await c.outboxRepository.finalize({
        processed,
        failures:
          failed === undefined
            ? []
            : [{ id: failed, error: "boom", nextAttemptAt: NOW }],
        now: NOW,
      });
    };

    const results = await Promise.allSettled([
      ...Array.from({ length: 10 }, (_, i) => insertOne(c, `uow-${i}`)),
      ...Array.from({ length: 5 }, relayTick),
      ...Array.from({ length: 5 }, () =>
        c.idempotencyStore.markProcessed(EventId.create(c.idGenerator.next())),
      ),
      c.outboxRepository.pruneProcessed(new Date(NOW.getTime() + 1)),
    ]);

    expect(statuses(results)).toEqual(results.map(() => "fulfilled"));
    expect(await c.db.select().from(schema.todos)).toHaveLength(15);
  });

  it("refuses an interactive transaction at runtime too", async () => {
    container = await createTestContainer();
    // `Database` exposes neither `transaction` nor `$client`.
    const { $client } = container.db as unknown as { $client: Client };
    await expect($client.transaction("write")).rejects.toThrow(/db\.batch\(\)/);
  });

  it("recovers once a lock held by another connection is released", async () => {
    container = await createTestContainer({ busyTimeoutMs: 50 });
    const c = container;
    // Stands in for another process (a migration, the sqlite3 CLI).
    const rival = createLibsqlClient({ url: c.url });
    const held = await rival.transaction("write");
    try {
      let settled = false;
      const blocked = insertOne(c, "blocked").then(
        () => null,
        (error: unknown) => error,
      );
      void blocked.then(() => {
        settled = true;
      });
      // Whatever runs in between must never see the reopened connection
      // without its PRAGMAs.
      const seen = new Set<unknown>();
      while (!settled) {
        seen.add(await busyTimeout(c));
      }
      expect(isSystemError(await blocked)).toBe(true);
      expect([...seen]).toEqual([50]);
      await held.commit();

      await insertOne(c, "after-release-1");
      await insertOne(c, "after-release-2");
      expect(await c.db.select().from(schema.todos)).toHaveLength(2);
      expect(await busyTimeout(c)).toBe(50);
    } finally {
      held.close();
      rival.close();
    }
  });
});
