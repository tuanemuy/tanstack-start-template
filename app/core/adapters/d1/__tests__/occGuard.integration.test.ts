import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { occGuard, outboxEvents, todos } from "../schema";

// Phase-1 hypothesis check: does the `_occ_guard` CHECK-constraint trick
// actually abort an entire D1 batch when an OCC-guarded UPDATE matches
// zero rows?
//
// The deferred-batch UoW design hinges on this. If D1 happens to commit
// the batch despite the CHECK violation (or if `changes()` does not
// reflect the prior statement's row count inside a batch), the whole
// approach is unworkable and we need a different abort mechanism.
//
// These tests pin the contract end-to-end against a real Workers /
// Miniflare D1 binding.
describe("OCC guard via _occ_guard CHECK constraint", () => {
  it("aborts the entire batch when the guarded UPDATE matches zero rows", async () => {
    const db = drizzle(env.DB, { schema: { todos, occGuard } });

    const now = new Date();
    await db.insert(todos).values({
      id: "todo-1",
      title: "original",
      status: "pending",
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Stale version: row is at v=0, attempt to advance from v=99 → v=100.
    // The UPDATE will match zero rows, the guard INSERT will violate the
    // CHECK constraint, and the entire batch must roll back.
    const stalePreviousVersion = 99;
    const promise = db.batch([
      db
        .update(todos)
        .set({ title: "should-not-stick", version: 100, updatedAt: now })
        .where(
          sql`${todos.id} = 'todo-1' AND ${todos.version} = ${stalePreviousVersion}`,
        ),
      db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    ]);

    await expect(promise).rejects.toThrow();

    // Row must be untouched. If the batch silently succeeded despite the
    // UPDATE matching zero rows, this read would still see v=0 / "original"
    // — which is the same observation, so we also assert the row count
    // and the absence of stray guard rows below.
    const rows = await db.select().from(todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "todo-1",
      title: "original",
      version: 0,
    });

    // The guard INSERT must have rolled back too — no stray rows.
    const guardRows = await db.select().from(occGuard);
    expect(guardRows).toHaveLength(0);
  });

  it("commits the batch when the guarded UPDATE matches a row", async () => {
    const db = drizzle(env.DB, { schema: { todos, occGuard } });

    const now = new Date();
    await db.insert(todos).values({
      id: "todo-2",
      title: "original",
      status: "pending",
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Matching version → UPDATE touches 1 row → guard SELECT yields no
    // rows → INSERT is a no-op → batch commits cleanly with the guard
    // table left empty.
    await db.batch([
      db
        .update(todos)
        .set({ title: "updated", version: 1, updatedAt: now })
        .where(sql`${todos.id} = 'todo-2' AND ${todos.version} = 0`),
      db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    ]);

    const rows = await db.select().from(todos);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "todo-2",
      title: "updated",
      version: 1,
    });

    const guardRows = await db.select().from(occGuard);
    expect(guardRows).toHaveLength(0);
  });

  it("rolls back co-batched INSERTs when a later OCC-guarded UPDATE fails", async () => {
    const db = drizzle(env.DB, { schema: { todos, occGuard } });

    const now = new Date();
    await db.insert(todos).values({
      id: "todo-3",
      title: "original",
      status: "pending",
      version: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Simulates: aggregate save (UPDATE with stale version) plus an
    // outbox event INSERT in the same batch. The outbox row must NOT
    // be persisted when the OCC check fails — this is the property
    // that makes "writes ⇔ outbox" atomicity hold under D1.
    const promise = db.batch([
      db.insert(outboxEvents).values({
        id: "evt-1",
        eventType: "todo.updated",
        aggregateId: "todo-3",
        payload: {},
        occurredAt: now,
        createdAt: now,
      }),
      db
        .update(todos)
        .set({ title: "should-not-stick", version: 100, updatedAt: now })
        .where(sql`${todos.id} = 'todo-3' AND ${todos.version} = 99`),
      db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    ]);

    await expect(promise).rejects.toThrow();

    const outboxRows = await db.select().from(outboxEvents);
    expect(outboxRows).toHaveLength(0);
  });
});
