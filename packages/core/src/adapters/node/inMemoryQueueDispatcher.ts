import type {
  EventDispatcher,
  EventDispatchOutcome,
} from "@repo/core/application/workers/eventRelayWorker";
import type { DomainEvent } from "@repo/core/domain/common/event";

/**
 * Cloudflare `MessageBatch` analog. A handler that returns without
 * calling `ack` / `retry` is treated as acked, matching CF Queues' default.
 */
export type LocalMessage<T> = {
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(): void;
};

export type ConsumerHandler = (event: DomainEvent) => Promise<void>;

export type CreateInMemoryQueueDispatcherOptions = Readonly<{
  handler: ConsumerHandler;
  concurrency?: number;
}>;

const DEFAULT_CONCURRENCY = 1;

type LocalOutcome =
  | { readonly kind: "ack" }
  | { readonly kind: "retry"; readonly error: unknown };

async function invoke(
  handler: ConsumerHandler,
  event: DomainEvent,
): Promise<LocalOutcome> {
  let decision: LocalOutcome | null = null;
  const message: LocalMessage<DomainEvent> = {
    body: event,
    attempts: 1,
    ack: () => {
      if (decision === null) decision = { kind: "ack" };
    },
    retry: () => {
      if (decision === null) {
        decision = {
          kind: "retry",
          error: new Error("consumer requested retry"),
        };
      }
    },
  };
  try {
    await handler(message.body);
    if (decision === null) message.ack();
  } catch (error) {
    if (decision === null) {
      decision = { kind: "retry", error };
    }
  }
  return decision ?? { kind: "ack" };
}

/**
 * Adapts the `ack` / `retry` / throw contract to `EventDispatcher`:
 * a thrown handler or explicit `retry()` becomes a failure outcome so
 * `processOutboxEvents` retains ownership of attempts / backoff /
 * quarantine. `concurrency` bounds in-flight handlers.
 */
export function createInMemoryQueueDispatcher(
  options: CreateInMemoryQueueDispatcherOptions,
): EventDispatcher {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  return async (events: readonly DomainEvent[]) => {
    if (events.length === 0) return [];

    const outcomes: EventDispatchOutcome[] = new Array(events.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= events.length) return;
        const event = events[index];
        if (event === undefined) return;
        const local = await invoke(options.handler, event);
        outcomes[index] =
          local.kind === "ack"
            ? { kind: "success", id: event.id }
            : { kind: "failure", id: event.id, error: local.error };
      }
    };

    const workers: Promise<void>[] = [];
    const workerCount = Math.min(concurrency, events.length);
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);

    return outcomes;
  };
}
