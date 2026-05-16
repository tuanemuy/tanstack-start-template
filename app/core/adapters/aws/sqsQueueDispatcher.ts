import {
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  EventDispatcher,
  EventDispatchOutcome,
} from "@/core/application/workers/eventRelayWorker";
import type { DomainEvent, EventId } from "@/core/domain/common/event";

export type SqsQueueDispatcherDeps = Readonly<{
  client: SQSClient;
  queueUrl: string;
}>;

// SQS `SendMessageBatch` accepts at most 10 entries per call. Splitting the
// relay batch here keeps `processOutboxEvents` free of transport limits.
const MAX_SQS_BATCH = 10;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * SQS implementation of {@link EventDispatcher}. The relay batch is sliced
 * into chunks of 10 (the SQS hard limit), each chunk is sent via
 * `SendMessageBatchCommand`, and the response's `Successful` / `Failed`
 * arrays are mapped back to per-event outcomes keyed on `event.id`.
 *
 * A network-level rejection of an individual chunk reports failure for
 * every event in that chunk so `processOutboxEvents` can retry them in
 * the next tick.
 */
export function createSqsQueueDispatcher(
  deps: SqsQueueDispatcherDeps,
): EventDispatcher {
  const { client, queueUrl } = deps;

  return async (events: readonly DomainEvent[]) => {
    if (events.length === 0) return [];

    // The SQS response echoes `Entry.Id` as a plain string; build a set
    // of in-batch ids so we can drop any echo that doesn't correspond to
    // one of our events (defensive — shouldn't happen in practice).
    const inBatch = new Set<string>(events.map((e) => e.id));
    const outcomesById = new Map<EventId, EventDispatchOutcome>();

    for (const slice of chunk(events, MAX_SQS_BATCH)) {
      const entries: SendMessageBatchRequestEntry[] = slice.map((event) => ({
        // `Id` is opaque to SQS but must be unique within the batch and
        // ≤80 chars / ASCII alnum + `-_`. Event ids (UUIDv7) satisfy the
        // constraint.
        Id: event.id,
        MessageBody: JSON.stringify(event),
      }));

      try {
        const response = await client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: entries,
          }),
        );

        for (const success of response.Successful ?? []) {
          if (success.Id === undefined || !inBatch.has(success.Id)) continue;
          const id = success.Id as EventId;
          outcomesById.set(id, { kind: "success", id });
        }
        for (const failure of response.Failed ?? []) {
          if (failure.Id === undefined || !inBatch.has(failure.Id)) continue;
          const id = failure.Id as EventId;
          outcomesById.set(id, {
            kind: "failure",
            id,
            error: new Error(
              `SQS SendMessageBatch failed: code=${failure.Code ?? "unknown"} message=${failure.Message ?? "unknown"} senderFault=${failure.SenderFault ?? false}`,
            ),
          });
        }
      } catch (error) {
        for (const event of slice) {
          outcomesById.set(event.id, {
            kind: "failure",
            id: event.id,
            error,
          });
        }
      }
    }

    return events.map(
      (event) =>
        outcomesById.get(event.id) ?? {
          kind: "failure" as const,
          id: event.id,
          error: new Error(
            `SQS SendMessageBatch returned no outcome for event ${event.id}`,
          ),
        },
    );
  };
}
