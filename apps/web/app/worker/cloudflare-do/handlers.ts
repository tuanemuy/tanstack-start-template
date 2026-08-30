import type {
  DurableObjectNamespace,
  ExecutionContext,
  MessageBatch,
} from "@cloudflare/workers-types";
import {
  DEFAULT_TODO_SCOPE,
  type TodoStateClient,
} from "@repo/core/adapters/do/protocol";
import { createDoConsumerContainer } from "@repo/core/application/di/serverCloudflareDo";
import type { DomainEvent } from "@repo/core/domain/common/event";

/**
 * Queue-facing roles of the DO runtime. Relay and pruner have no
 * Worker here — both run inside the todo-state DO's alarm — so the
 * only siblings are this consumer and the DLQ, and their idempotency
 * stamps travel back into the DO via RPC instead of a shared database.
 */
export type ConsumerEnv = Readonly<{
  APP_URL: string;
  TODO_STATE: DurableObjectNamespace;
}>;

export type DlqEnv = ConsumerEnv;

// Same single widening cast as the server entry: the stub's RPC surface
// mirrors `TodoStateClient` by construction.
function todoStateClient(env: ConsumerEnv): TodoStateClient {
  const stub = env.TODO_STATE.get(
    env.TODO_STATE.idFromName(DEFAULT_TODO_SCOPE),
  );
  return stub as unknown as TodoStateClient;
}

export async function handleQueue(
  batch: MessageBatch<DomainEvent>,
  env: ConsumerEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const container = createDoConsumerContainer(todoStateClient(env));
  for (const message of batch.messages) {
    try {
      const { alreadyProcessed } =
        await container.idempotencyStore.markProcessed(message.body.id);
      if (alreadyProcessed) {
        container.logger.info(
          `[queue] skipping redelivery of ${message.body.type} ${message.body.id}`,
          { eventId: message.body.id },
        );
        message.ack();
        continue;
      }
      container.logger.info(
        `[queue] received ${message.body.type} ${message.body.id}`,
        { event: message.body },
      );
      message.ack();
    } catch (error) {
      container.logger.error(
        `[queue] handler failed for ${message.body.type} ${message.body.id}`,
        { eventId: message.body.id, cause: error },
      );
      message.retry();
    }
  }
}

/**
 * Always acks: the DLQ has no further dead-letter target, so a
 * re-failure would loop. Re-driving is a manual operator action once
 * the upstream cause is resolved.
 */
export async function handleDlq(
  batch: MessageBatch<DomainEvent>,
  env: DlqEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const container = createDoConsumerContainer(todoStateClient(env));
  for (const message of batch.messages) {
    container.logger.error(
      `[dlq] event quarantined after retries: ${message.body.type} ${message.body.id}`,
      {
        eventId: message.body.id,
        eventType: message.body.type,
        attempts: message.attempts,
        event: message.body,
      },
    );
    message.ack();
  }
}
