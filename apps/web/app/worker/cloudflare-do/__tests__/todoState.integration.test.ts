import { env, runInDurableObject } from "cloudflare:test";
import type { TodoStateClient } from "@repo/core/adapters/do/protocol";
import { DoUnitOfWorkProvider } from "@repo/core/adapters/do/unitOfWork";
import { isConflictError } from "@repo/core/application/errors";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { EventId } from "@repo/core/domain/common/event";
import { Todo } from "@repo/core/domain/todo/entity";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { describe, expect, it, vi } from "vitest";

// End-to-end integration of the DO runtime against a real SQLite-backed
// Durable Object in Miniflare: the request-side deferred-command UoW,
// the DO-side transactional commit with per-statement OCC, the alarm
// relay to a real Miniflare queue, pruning, and the RPC idempotency
// store.
//
// Two Miniflare realities shape these tests. Alarms fire FOR REAL and
// almost immediately after `setAlarm(now)`, so "the alarm is armed" is
// not deterministically observable — the tests assert the *outcome* of
// the auto-fired relay via polling instead, which exercises the full
// commit → arm → alarm → dispatch → finalize loop. And DO storage is
// not reset between tests, so every test takes its own object via a
// unique instance name.
describe("TodoStateObject (integration)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  let counter = 0;
  const nextTodoId = () => {
    counter += 1;
    return TodoId.create(
      `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-8000-200000000000`,
    );
  };

  function freshStub() {
    return env.TODO_STATE.get(
      env.TODO_STATE.idFromName(`test-${crypto.randomUUID()}`),
    );
  }

  // Same widening cast the production entries use — the stub's RPC
  // surface mirrors `TodoStateClient` by construction.
  function asClient(stub: ReturnType<typeof freshStub>): TodoStateClient {
    return stub as unknown as TodoStateClient;
  }

  function createProvider(client: TodoStateClient) {
    return new DoUnitOfWorkProvider(client, UuidV7Generator);
  }

  it("commits aggregate writes and outbox rows atomically, then auto-relays via the alarm", async () => {
    const stub = freshStub();
    const provider = createProvider(asClient(stub));
    const { entity: todo, eventDrafts } = Todo.create(
      { id: nextTodoId(), title: "do-commit" },
      NOW,
    );

    await provider.run(async ({ todoRepository, collectEvents }) => {
      await todoRepository.insert(todo);
      collectEvents(eventDrafts);
    });

    await runInDurableObject(stub, (_instance, state) => {
      const todos = state.storage.sql.exec("SELECT id FROM todos").toArray();
      const outbox = state.storage.sql
        .exec("SELECT event_type FROM outbox_events")
        .toArray();
      expect(todos).toHaveLength(1);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.event_type).toBe("todo.created");
    });

    // Commit armed the alarm; the alarm fires on its own, dispatches to
    // the queue, and finalizes the row. Once drained it must not re-arm.
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (_instance, state) => {
        const outbox = state.storage.sql
          .exec("SELECT processed_at, claimed_at FROM outbox_events")
          .toArray();
        expect(outbox).toHaveLength(1);
        expect(outbox[0]?.processed_at).not.toBeNull();
        expect(outbox[0]?.claimed_at).toBeNull();
        expect(await state.storage.getAlarm()).toBeNull();
      });
    });
  });

  it("attributes an OCC conflict to the losing write and rolls the whole commit back", async () => {
    const stub = freshStub();
    const provider = createProvider(asClient(stub));
    const { entity: a } = Todo.create({ id: nextTodoId(), title: "do-a" }, NOW);
    const { entity: b } = Todo.create({ id: nextTodoId(), title: "do-b" }, NOW);
    await provider.run(async ({ todoRepository }) => {
      await todoRepository.insert(a);
      await todoRepository.insert(b);
    });

    const foundA = await provider.run(async ({ todoRepository }) =>
      todoRepository.findById(a.id),
    );
    const foundB = await provider.run(async ({ todoRepository }) =>
      todoRepository.findById(b.id),
    );
    if (
      !foundA ||
      !foundB ||
      !Todo.isActive(foundA.entity) ||
      !Todo.isActive(foundB.entity)
    ) {
      return;
    }

    // Advance B out-of-band so B's token goes stale while A's stays fresh.
    const { entity: bBumped } = Todo.complete(foundB.entity, NOW);
    await provider.run(async ({ todoRepository }) => {
      await todoRepository.save(bBumped, foundB.expectedVersion);
    });

    // One UoW: A saves with a fresh token, B with a stale one, plus an
    // event. The per-statement OCC check must name B — and A's write
    // and the event must both roll back.
    const { entity: aBumped, eventDrafts } = Todo.complete(foundA.entity, NOW);
    let caught: unknown;
    try {
      await provider.run(async ({ todoRepository, collectEvents }) => {
        await todoRepository.save(aBumped, foundA.expectedVersion);
        await todoRepository.save(bBumped, foundB.expectedVersion);
        collectEvents(eventDrafts);
      });
    } catch (error) {
      caught = error;
    }

    expect(isConflictError(caught)).toBe(true);
    expect((caught as Error).message).toContain(b.id);
    expect((caught as Error).message).not.toContain(a.id);

    const afterA = await provider.run(async ({ todoRepository }) =>
      todoRepository.findById(a.id),
    );
    expect(afterA?.entity.status).toBe("active");
    await runInDurableObject(stub, (_instance, state) => {
      const outbox = state.storage.sql
        .exec("SELECT id FROM outbox_events")
        .toArray();
      expect(outbox).toHaveLength(0);
    });
  });

  it("prunes processed rows past retention on the next alarm tick", async () => {
    const stub = freshStub();
    const client = asClient(stub);
    const ancient = new Date("2020-01-01T00:00:00.000Z").getTime();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO outbox_events
           (id, event_type, aggregate_id, payload, occurred_at, processed_at, created_at)
           VALUES (?, 'todo.created', 'agg', '{}', ?, ?, ?)`,
        "0193e7d0-aaaa-7000-8000-300000000000",
        ancient,
        ancient,
        ancient,
      );
    });

    await client.kickRelay();
    await vi.waitFor(async () => {
      await runInDurableObject(stub, (_instance, state) => {
        const outbox = state.storage.sql
          .exec("SELECT id FROM outbox_events")
          .toArray();
        expect(outbox).toHaveLength(0);
      });
    });
  });

  it("claims each event id exactly once through markEventProcessed", async () => {
    const client = asClient(freshStub());
    const id = EventId.create("0193e7d0-bbbb-7000-8000-300000000000");
    const first = await client.markEventProcessed(id);
    const second = await client.markEventProcessed(id);
    expect(first.alreadyProcessed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
  });

  it("pages todos newest-first through the repository", async () => {
    const provider = createProvider(asClient(freshStub()));
    for (let i = 0; i < 3; i++) {
      const { entity } = Todo.create(
        { id: nextTodoId(), title: `page-${i}` },
        new Date(NOW.getTime() + i * 1000),
      );
      await provider.run(async ({ todoRepository }) => {
        await todoRepository.insert(entity);
      });
    }
    const page = await provider.run(async ({ todoRepository }) =>
      todoRepository.findPage({ page: 1, limit: 2 }),
    );
    expect(page.count).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.title).toBe("page-2");
    expect(page.items[1]?.title).toBe("page-1");
  });
});
