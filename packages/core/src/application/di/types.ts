import type { UnitOfWorkProvider } from "../execution/unitOfWork";
import type { Clock } from "../ports/clock";
import type { IdempotencyStore } from "../ports/idempotencyStore";
import type { IdGenerator } from "../ports/idGenerator";
import type { Logger } from "../ports/logger";
import type { OutboxRepository } from "../ports/outboxRepository";

export type AppConfig = Readonly<{
  appUrl: string;
  siteName: string;
  defaultTitle: string;
  defaultDescription: string;
  twitterHandle?: string;
  themeColor: string;
}>;

/**
 * Cross-cutting deterministic deps shared between request and worker
 * containers. Held as ports so domain / application code stays free of
 * ambient time, id generation, and IO sinks.
 */
export type SharedDeps = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
}>;

/**
 * Request-path container. Provided to usecases that mutate aggregates
 * (which must run inside `unitOfWorkProvider.run`) and to the
 * presentation layer for SSR head/meta via `config`.
 *
 * Intentionally does NOT carry `outboxRepository` or
 * `idempotencyStore`: those are worker concerns. A request that needs
 * to enqueue a domain event uses the UoW's `collectEvents`, which
 * funnels through the transactional outbox write inside the unit of
 * work — never touching the repository directly.
 */
export type RequestContainer = SharedDeps &
  Readonly<{
    config: AppConfig;
    unitOfWorkProvider: UnitOfWorkProvider;
  }>;

/**
 * Worker-path container. Used by the relay (`processOutboxEvents`),
 * pruner (`pruneOutbox`), queue consumer, and DLQ handler.
 *
 * Intentionally does NOT carry `config` or `unitOfWorkProvider`:
 * `config` is SSR-only metadata, and worker code that reads/writes
 * the outbox does so through `outboxRepository` directly without a
 * unit of work (no aggregate is mutated).
 */
export type WorkerContainer = SharedDeps &
  Readonly<{
    outboxRepository: OutboxRepository;
    idempotencyStore: IdempotencyStore;
  }>;
