import {
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  EventDispatcher,
  EventDispatchOutcome,
} from "@repo/core/application/workers/eventRelayWorker";
import type { DomainEvent, EventId } from "@repo/core/domain/common/event";

export type SqsQueueDispatcherDeps = Readonly<{
  client: SQSClient;
  queueUrl: string;
}>;

// SQS `SendMessageBatch` accepts at most 10 entries per call.
const MAX_SQS_BATCH = 10;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * SQS implementation of {@link EventDispatcher}. Splits the relay batch
 * into 10-entry chunks (SQS hard limit), sends each via
 * `SendMessageBatchCommand`, and maps the response's `Successful` /
 * `Failed` arrays into per-event outcomes. A chunk-level rejection is
 * reported as failure for every event in that chunk; events with no
 * matching outcome are left out and the worker treats the absence as
 * failure.
 */
export function createSqsQueueDispatcher(
  deps: SqsQueueDispatcherDeps,
): EventDispatcher {
  const { client, queueUrl } = deps;

  return async (events: readonly DomainEvent[]) => {
    if (events.length === 0) return [];

    const outcomes: EventDispatchOutcome[] = [];

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
          outcomes.push({ kind: "success", id: success.Id as EventId });
        }
        for (const failure of response.Failed ?? []) {
          outcomes.push({
            kind: "failure",
            id: failure.Id as EventId,
            error: new Error(
              `SQS SendMessageBatch failed: code=${failure.Code ?? "unknown"} message=${failure.Message ?? "unknown"} senderFault=${failure.SenderFault ?? false}`,
            ),
          });
        }
      } catch (error) {
        for (const event of slice) {
          outcomes.push({ kind: "failure", id: event.id, error });
        }
      }
    }

    return outcomes;
  };
}
