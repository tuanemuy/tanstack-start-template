import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@repo/core/application/execution/unitOfWork";
import type { Clock } from "@repo/core/application/ports/clock";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import {
  NoopRelayTrigger,
  type RelayTrigger,
} from "@repo/core/application/ports/relayTrigger";
import {
  attachEventIds,
  type DomainEvent,
  EventId,
} from "@repo/core/domain/common/event";
import type { Database } from "./client";
import { PendingBatch } from "./pendingBatch";
import { isOccGuardViolation, mapDbError } from "./repositories/helpers";
import { LibsqlOutboxRepository } from "./repositories/outboxRepository";
import { LibsqlTodoRepository } from "./repositories/todoRepository";

/**
 * libSQL `UnitOfWorkProvider`. Reads run immediately against `db`;
 * writes accumulate on a `PendingBatch` and flush sequentially inside a
 * single interactive transaction. OCC failure surfaces via the
 * `_occ_guard` CHECK and is mapped to `ConflictError`. Read-your-write
 * within the same UoW is intentionally unsupported (matches the D1 adapter).
 */
export class LibsqlUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    // Default no-op so worker contexts can construct without a trigger.
    private readonly relayTrigger: RelayTrigger = NoopRelayTrigger,
  ) {}

  async run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    const pending = new PendingBatch();
    const collected: DomainEvent[] = [];

    const todoRepository = new LibsqlTodoRepository(
      this.db,
      pending,
      this.idGenerator,
    );
    const outbox = new LibsqlOutboxRepository(
      this.db,
      this.idGenerator,
      this.clock,
      pending,
    );

    const ctx: UnitOfWorkContext = {
      todoRepository,
      // EventId is minted here so domain factories stay identity-less.
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
      await outbox.save(collected);
    }

    if (pending.isEmpty()) {
      // Pure-read UoW: skip the transaction.
      return result;
    }

    const statements = pending.build();

    await mapDbError("Failed to commit unit of work", async () => {
      // Track the most recent OCC write's handler so a CHECK violation
      // on the following `occ-guard` is attributed to it. The mutable
      // wrapper sidesteps TS narrowing inside the closure.
      const handlerRef: { current: (() => never) | null } = { current: null };
      try {
        await this.db.transaction(async (tx) => {
          for (const stmt of statements) {
            if (stmt.kind === "occ") {
              handlerRef.current = stmt.onConflict;
            }
            await stmt.run(tx);
          }
        });
      } catch (error) {
        if (isOccGuardViolation(error) && handlerRef.current !== null) {
          handlerRef.current();
        }
        throw error;
      }
    });

    // Post-commit: kicking before the tx resolves would race the relay
    // against rows that may roll back.
    if (collected.length > 0) {
      this.relayTrigger.kick();
    }

    return result;
  }
}
