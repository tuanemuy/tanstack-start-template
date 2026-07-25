import { Todo } from "@repo/core/domain/todo/entity";
import { TodoEvents } from "@repo/core/domain/todo/events";
import { TodoId } from "@repo/core/domain/todo/valueObject";
import { afterEach, describe, expect, it } from "vitest";
import { occGuard, outboxEvents } from "../schema";
import { createTestContainer, type TestContainer } from "./helpers";

/**
 * End-to-end check that the `_occ_guard` CHECK-constraint trick aborts an
 * entire libSQL interactive transaction when an OCC-guarded UPDATE matches
 * zero rows. Mirrors the D1 adapter's `occGuard.integration.test.ts`
 * because the guarantee is identical: any path through the UoW that fires
 * the guard must leave `_occ_guard` empty and roll back co-batched writes.
 */
describe("OCC guard via _occ_guard CHECK constraint (libSQL)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  let counter = 0;
  const nextTodoId = () => {
    counter += 1;
    return TodoId.create(
      `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-8000-400000000000`,
    );
  };

  let container: TestContainer | null = null;
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("keeps _occ_guard empty across a successful commit", async () => {
    container = await createTestContainer();
    const { entity: todo, eventDrafts } = Todo.create(
      { id: nextTodoId(), title: "ok" },
      NOW,
    );
    await container.unitOfWorkProvider.run(
      async ({ todoRepository, collectEvents }) => {
        await todoRepository.insert(todo);
        collectEvents(eventDrafts);
      },
    );

    const found = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(todo.id),
    );
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: completed } = Todo.complete(found.entity, NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(completed, found.expectedVersion);
    });

    const guardRows = await container.db.select().from(occGuard);
    expect(guardRows).toHaveLength(0);
  });

  it("keeps _occ_guard empty after a failed OCC commit", async () => {
    container = await createTestContainer();
    const { entity: active } = Todo.create(
      { id: nextTodoId(), title: "fail" },
      NOW,
    );
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.insert(active);
    });

    const found = await container.unitOfWorkProvider.run(
      async ({ todoRepository }) => todoRepository.findById(active.id),
    );
    if (!found || !Todo.isActive(found.entity)) return;
    const { entity: bumped } = Todo.complete(found.entity, NOW);
    await container.unitOfWorkProvider.run(async ({ todoRepository }) => {
      await todoRepository.save(bumped, found.expectedVersion);
    });

    let threw = false;
    try {
      await container.unitOfWorkProvider.run(
        async ({ todoRepository, collectEvents }) => {
          await todoRepository.save(bumped, found.expectedVersion);
          collectEvents([TodoEvents.toggled(active.id, true, NOW)]);
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Guard table must stay empty — the CHECK aborts the transaction before
    // any row can persist on either the success or conflict path.
    const guardRows = await container.db.select().from(occGuard);
    expect(guardRows).toHaveLength(0);
    // Co-batched outbox insert was rolled back along with the failing
    // UPDATE — this is the property that makes "writes ⇔ outbox" atomicity
    // hold under the libSQL adapter.
    const outboxRows = await container.db.select().from(outboxEvents);
    expect(outboxRows).toHaveLength(0);
  });
});
