import { DurableObject } from "cloudflare:workers";
import type { Queue } from "@cloudflare/workers-types";
import { runOutboxAlarmTick } from "@repo/core/adapters/do/alarm";
import {
  DoSqliteIdempotencyStore,
  DoSqliteOutboxRepository,
  nextOutboxWakeUpAt,
} from "@repo/core/adapters/do/outboxStore";
import type {
  CommitRequest,
  CommitResult,
  TodoStateRow,
} from "@repo/core/adapters/do/protocol";
import { applyDoSchema } from "@repo/core/adapters/do/schema";
import {
  applyCommit,
  findTodoById,
  findTodoPage,
} from "@repo/core/adapters/do/stateStore";
import {
  readPruneTuning,
  readRelayTuning,
  type TuningEnv,
} from "@repo/core/application/di/env";
import type { WorkerContainer } from "@repo/core/application/di/types";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import type { EventDispatcher } from "@repo/core/application/workers/eventRelayWorker";
import { type DomainEvent, EventId } from "@repo/core/domain/common/event";
import type {
  Pagination,
  PaginationResult,
} from "@repo/core/domain/common/pagination";

export type TodoStateEnv = TuningEnv &
  Readonly<{
    EVENTS_QUEUE: Queue<DomainEvent>;
  }>;

/**
 * SQLite-backed Durable Object owning the todo aggregate AND its
 * outbox. One instance per scope (`DEFAULT_TODO_SCOPE` in this
 * template; per-tenant in a real app).
 *
 * Three responsibilities meet here and nowhere else:
 *
 * - **State**: `findTodoById` / `findTodoPage` / `commit` are the RPC
 *   surface the request Worker's adapters consume. `commit` applies a
 *   whole unit of work in one `transactionSync` — aggregate writes and
 *   outbox rows are atomic by construction, not by deferred batching.
 * - **Relay**: `alarm()` drains the DO-local outbox to the Queue with
 *   the same `processOutboxEvents` policy the other runtimes run in a
 *   sibling Worker. Alarms are platform-guaranteed and retried on
 *   throw, so there is no safety-net cron: the armed-whenever-pending
 *   invariant (commit arms, alarm re-arms) is the whole trigger model.
 * - **Idempotency**: `processed_events` lives next to the data it
 *   guards; the consumer Worker claims through `markEventProcessed`.
 */
export class TodoStateObject extends DurableObject<TodoStateEnv> {
  constructor(ctx: DurableObjectState, env: TodoStateEnv) {
    super(ctx, env);
    // Synchronous and idempotent; runs to completion before the first
    // request is delivered, so no request can observe a missing table.
    applyDoSchema(ctx.storage.sql);
  }

  async findTodoById(id: string): Promise<TodoStateRow | null> {
    return findTodoById(this.ctx.storage.sql, id);
  }

  async findTodoPage(
    pagination: Pagination,
  ): Promise<PaginationResult<TodoStateRow>> {
    return findTodoPage(this.ctx.storage.sql, pagination);
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
    const result = applyCommit(
      this.ctx.storage.sql,
      (fn) => this.ctx.storage.transactionSync(fn),
      request,
      SystemClock.now(),
    );
    if (result.kind === "committed" && request.events.length > 0) {
      await this.armAlarmAsap();
    }
    return result;
  }

  async markEventProcessed(id: string): Promise<{ alreadyProcessed: boolean }> {
    const store = new DoSqliteIdempotencyStore(
      this.ctx.storage.sql,
      SystemClock,
    );
    return store.markProcessed(EventId.create(id));
  }

  async kickRelay(): Promise<void> {
    await this.armAlarmAsap();
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const relayTuning = readRelayTuning(this.env);
    const container: WorkerContainer = {
      clock: SystemClock,
      idGenerator: UuidV7Generator,
      logger: ConsoleLogger,
      outboxRepository: new DoSqliteOutboxRepository(
        sql,
        UuidV7Generator,
        SystemClock,
      ),
      idempotencyStore: new DoSqliteIdempotencyStore(sql, SystemClock),
    };
    // Same batched contract as the sibling-Worker relay: `sendBatch`
    // is all-or-nothing, so a rejection reports every event as failed
    // and the whole batch reschedules uniformly.
    const dispatch: EventDispatcher = async (events) => {
      if (events.length === 0) return [];
      try {
        await this.env.EVENTS_QUEUE.sendBatch(events.map((body) => ({ body })));
        return events.map((event) => ({
          kind: "success" as const,
          id: event.id,
        }));
      } catch (error) {
        return events.map((event) => ({
          kind: "failure" as const,
          id: event.id,
          error,
        }));
      }
    };
    await runOutboxAlarmTick({
      container,
      dispatch,
      relayTuning,
      retentionMs: readPruneTuning(this.env).retentionMs,
      nextWakeUpAt: () => nextOutboxWakeUpAt(sql, relayTuning.leaseMs),
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
    });
  }

  private async armAlarmAsap(): Promise<void> {
    const now = SystemClock.now();
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > now.getTime()) {
      await this.ctx.storage.setAlarm(now);
    }
  }
}
