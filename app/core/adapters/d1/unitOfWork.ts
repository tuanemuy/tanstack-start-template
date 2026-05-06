import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@/core/application/execution/unitOfWork";
import type { Clock } from "@/core/application/ports/clock";
import type { IdGenerator } from "@/core/application/ports/idGenerator";
import {
  attachEventIds,
  type DomainEvent,
  EventId,
} from "@/core/domain/common/event";
import type { Database } from "./client";
import { PendingBatch } from "./pendingBatch";
import { isOccGuardViolation, mapDbError } from "./repositories/helpers";
import { D1OutboxRepository } from "./repositories/outboxRepository";
import { D1TodoRepository } from "./repositories/todoRepository";

/**
 * D1 implementation of `UnitOfWorkProvider`.
 *
 * D1 has no interactive transactions, so a `db.transaction(fn)` shape
 * is impossible. The replacement is a deferred-batch model:
 *
 *   1. The caller's `fn` runs through to completion. Reads execute
 *      immediately against `db`; writes (and outbox events) accumulate
 *      on a `PendingBatch`.
 *
 *   2. After `fn` returns, a single `db.batch()` flushes everything
 *      atomically. If the batch fails because an OCC-guarded write
 *      matched zero rows (`_occ_guard` CHECK violation), the buffer's
 *      head conflict handler throws a domain-friendly
 *      `ConflictError("OPTIMISTIC_LOCK_FAILURE")`. Other driver errors
 *      are translated through `mapDbError`.
 *
 * Read-your-write within the same UoW is unsupported by design — see
 * `D1TodoRepository` for the rationale.
 *
 * No application-level retry: D1 surfaces transient conditions
 * (`SQLITE_BUSY` / `SQLITE_LOCKED`) as connection-level errors that
 * the binding handles upstream of this adapter, and OCC mismatches
 * are caller-visible signals rather than retry candidates.
 */
export class D1UnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    const pending = new PendingBatch(this.db);
    const collected: DomainEvent[] = [];

    const todoRepository = new D1TodoRepository(
      this.db,
      pending,
      this.idGenerator,
    );
    const outbox = new D1OutboxRepository(this.db, this.idGenerator, pending);

    const ctx: UnitOfWorkContext = {
      todoRepository,
      // `EventId` is minted here, on the path between domain emission
      // and outbox persistence — keeping id generation a single
      // application-layer concern. Domain factories return identity-less
      // drafts; usecases never see `idGenerator`.
      collectEvents: (drafts) => {
        collected.push(
          ...attachEventIds(drafts, () =>
            EventId.create(this.idGenerator.next()),
          ),
        );
      },
    };

    const result = await fn(ctx);

    if (collected.length > 0) {
      await outbox.save(collected, this.clock.now());
    }

    if (pending.isEmpty()) {
      // Nothing to flush — pure-read UoW. D1 rejects empty batches, so
      // exit before calling `db.batch()`.
      return result;
    }

    await mapDbError("Failed to commit unit of work", async () => {
      try {
        await this.db.batch(pending.build());
      } catch (error) {
        if (isOccGuardViolation(error)) {
          const handler = pending.firstConflictHandler();
          // Defensive: a guard violation without a registered handler
          // would mean the batch carried an `_occ_guard` statement
          // without an `addOcc` registration — i.e. the buffer was
          // built incorrectly. Throw the original error so the bug is
          // not swallowed.
          if (handler) handler();
        }
        throw error;
      }
    });

    return result;
  }
}
