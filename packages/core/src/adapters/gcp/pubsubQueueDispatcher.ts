import { Buffer } from "node:buffer";
import type { PubSub, Topic } from "@google-cloud/pubsub";
import type {
  EventDispatcher,
  EventDispatchOutcome,
} from "@repo/core/application/workers/eventRelayWorker";
import type { DomainEvent, EventId } from "@repo/core/domain/common/event";

export type PubsubQueueDispatcherDeps = Readonly<{
  client: PubSub;
  topicName: string;
}>;

/**
 * Pub/Sub implementation of {@link EventDispatcher}. `Promise.allSettled`
 * keeps a single publish failure from poisoning the rest of the batch;
 * the `Topic` handle is cached so the underlying `Publisher`'s batching
 * window survives across ticks.
 */
export function createPubsubQueueDispatcher(
  deps: PubsubQueueDispatcherDeps,
): EventDispatcher {
  const { client, topicName } = deps;
  let topic: Topic | null = null;
  const getTopic = (): Topic => {
    if (topic === null) topic = client.topic(topicName);
    return topic;
  };

  return async (events: readonly DomainEvent[]) => {
    if (events.length === 0) return [];

    const t = getTopic();
    const settled = await Promise.allSettled(
      events.map((event) =>
        t.publishMessage({
          data: Buffer.from(JSON.stringify(event)),
        }),
      ),
    );

    return events.map((event, index): EventDispatchOutcome => {
      const result = settled[index];
      if (result === undefined) {
        return {
          kind: "failure" as const,
          id: event.id,
          error: new Error(
            `Pub/Sub publishMessage returned no outcome for event ${event.id}`,
          ),
        };
      }
      if (result.status === "fulfilled") {
        return { kind: "success" as const, id: event.id as EventId };
      }
      return {
        kind: "failure" as const,
        id: event.id,
        error: result.reason,
      };
    });
  };
}
