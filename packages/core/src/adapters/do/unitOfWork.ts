import { ConflictError } from "@repo/core/application/errors";
import type {
  UnitOfWorkContext,
  UnitOfWorkProvider,
} from "@repo/core/application/execution/unitOfWork";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import {
  attachEventIds,
  type DomainEvent,
  EventId,
} from "@repo/core/domain/common/event";
import { mapDoError } from "./helpers";
import type {
  CommitRequest,
  TodoStateClient,
  TodoWriteCommand,
} from "./protocol";
import { DoTodoRepository } from "./todoRepository";

/**
 * Durable Object implementation of `UnitOfWorkProvider`.
 *
 * The callback runs in the request Worker; reads RPC to the DO
 * immediately while writes (and outbox events) buffer locally as plain
 * commands. After `fn` returns, one `commit` RPC ships the buffer and
 * the DO applies it inside a real `transactionSync` — aggregate writes
 * and outbox rows commit atomically, and OCC is checked per statement
 * so a conflict is attributed to the exact write that lost.
 *
 * There is no relay trigger here: committing events arms the DO's own
 * alarm inside the same RPC, which replaces the Service-Binding kick
 * and the safety-net cron of the sibling-Worker topology.
 */
export class DoUnitOfWorkProvider implements UnitOfWorkProvider {
  constructor(
    private readonly client: TodoStateClient,
    private readonly idGenerator: IdGenerator,
  ) {}

  async run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    const writes: TodoWriteCommand[] = [];
    const collected: DomainEvent[] = [];

    const todoRepository = new DoTodoRepository(
      this.client,
      writes,
      this.idGenerator,
    );

    const ctx: UnitOfWorkContext = {
      todoRepository,
      // `EventId` is minted here, matching the other providers: domain
      // factories return identity-less drafts and usecases never see
      // `idGenerator`.
      collectEvents: (drafts) => {
        collected.push(
          ...attachEventIds(drafts, () =>
            EventId.create(this.idGenerator.next()),
          ),
        );
      },
    };

    const result = await fn(ctx);

    if (writes.length === 0 && collected.length === 0) {
      return result;
    }

    const request: CommitRequest = {
      writes,
      events: collected.map((event) => ({
        id: event.id,
        type: event.type,
        payload: event.payload,
        occurredAt: event.occurredAt,
        aggregateId: event.aggregateId,
      })),
    };

    const outcome = await mapDoError("Failed to commit unit of work", () =>
      this.client.commit(request),
    );
    if (outcome.kind === "conflict") {
      const verb = outcome.command === "save" ? "saving" : "deleting";
      throw new ConflictError(
        "OPTIMISTIC_LOCK_FAILURE",
        `Optimistic lock failure while ${verb} todo ${outcome.todoId}: expected version ${outcome.expectedVersion}`,
      );
    }
    return result;
  }
}
