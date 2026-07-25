import {
  InvocationType,
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Client } from "@libsql/client";
import { loadSecretsIntoEnv } from "@repo/core/adapters/aws/secretsLoader";
import { createSqsQueueDispatcher } from "@repo/core/adapters/aws/sqsQueueDispatcher";
import {
  createLibsqlClient,
  type Database,
  getDatabase,
} from "@repo/core/adapters/libsql/client";
import {
  type AwsServerEnv,
  createAwsWorkerContainer,
  readAwsServerEnv,
  readPruneTuning,
  readRelayTuning,
} from "@repo/core/application/di/serverAws";
import type { WorkerContainer } from "@repo/core/application/di/types";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_ITERATIONS,
  defaultEventDecoderRegistry,
  type EventDecoderRegistry,
  type ProcessOutboxEventsOptions,
  processOutboxEvents,
} from "@repo/core/application/workers/eventRelayWorker";
import {
  type PruneOutboxOptions,
  pruneOutbox,
} from "@repo/core/application/workers/outboxPrune";
import {
  type DomainEvent,
  type EventDecoder,
  EventId,
} from "@repo/core/domain/common/event";
import type {
  SQSBatchItemFailure,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";

/**
 * Cold-start cache: Lambda re-uses the container across invocations on a
 * warm sandbox, so the libSQL client and worker container are constructed
 * once per execution environment.
 */
type WorkerBoot = Readonly<{
  env: AwsServerEnv;
  client: Client;
  db: Database;
  container: WorkerContainer;
}>;

let workerBootPromise: Promise<WorkerBoot> | null = null;

async function bootWorker(): Promise<WorkerBoot> {
  const tokenSecretArn = process.env["DATABASE_AUTH_TOKEN_SECRET_ARN"];
  if (tokenSecretArn !== undefined && tokenSecretArn !== "") {
    await loadSecretsIntoEnv({
      client: new SecretsManagerClient({}),
      bindings: [{ secretId: tokenSecretArn, envVar: "DATABASE_AUTH_TOKEN" }],
    });
  }

  const env = readAwsServerEnv();
  const client = createLibsqlClient({
    url: env.DATABASE_URL,
    ...(env.DATABASE_AUTH_TOKEN !== undefined
      ? { authToken: env.DATABASE_AUTH_TOKEN }
      : {}),
  });
  const db = getDatabase(client);
  const container = createAwsWorkerContainer(db);
  return { env, client, db, container };
}

export function getWorkerBoot(): Promise<WorkerBoot> {
  if (workerBootPromise === null) {
    workerBootPromise = bootWorker().catch((cause) => {
      // A failed cold start should not poison the container forever —
      // a transient Turso outage during boot can recover on the next
      // invocation.
      workerBootPromise = null;
      throw cause;
    });
  }
  return workerBootPromise;
}

const sqsClient = new SQSClient({});
const lambdaClient = new LambdaClient({});

export async function runRelayTick(
  override?: ProcessOutboxEventsOptions,
): Promise<{ processed: number }> {
  const { env, container } = await getWorkerBoot();
  const queueUrl = env.EVENTS_QUEUE_URL;
  if (queueUrl === undefined) {
    throw new Error(
      "[worker.aws.relay] EVENTS_QUEUE_URL is required for the relay Lambda",
    );
  }
  const dispatcher = createSqsQueueDispatcher({
    client: sqsClient,
    queueUrl,
  });
  // `readRelayTuning` only covers env-tunable knobs (batch size / lease /
  // attempts). `maxIterations` is a worker-internal cap; we resolve the
  // default here so the same value flows both into `processOutboxEvents`
  // AND into the saturation check below.
  const relayTuning = readRelayTuning(env);
  const tuning: ProcessOutboxEventsOptions = {
    batchSize: relayTuning.batchSize,
    leaseMs: relayTuning.leaseMs,
    maxAttempts: relayTuning.maxAttempts,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    ...override,
  };
  const result = await processOutboxEvents(container, dispatcher, tuning);

  // CF's Service Binding lets the relay tail-chain itself; on AWS the
  // equivalent is an async self-invoke. If the tick exited because it
  // hit `maxIterations` (every iteration drained a full batch and more
  // rows likely remain), kick another invocation so the safety-net cron
  // is not the only path to drain a backlog.
  const batchSize = tuning.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxIterations = tuning.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const looksDrainable = result.processed >= batchSize * maxIterations;
  if (looksDrainable && env.RELAY_FUNCTION_NAME !== undefined) {
    try {
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: env.RELAY_FUNCTION_NAME,
          InvocationType: InvocationType.Event,
        }),
      );
    } catch (cause) {
      // Failure here is non-fatal: the EventBridge safety net will pick
      // up the backlog on the next tick.
      container.logger.warn(
        "[worker.aws.relay] self-chained invoke failed; relying on cron",
        { cause },
      );
    }
  }

  return result;
}

export async function runPruneTick(
  override?: Partial<PruneOutboxOptions>,
): Promise<{ deleted: number }> {
  const { env, container } = await getWorkerBoot();
  return pruneOutbox(container, { ...readPruneTuning(env), ...override });
}

// SQS message bodies are JSON-encoded `DomainEvent`s produced by the
// relay Lambda. JSON.parse loses Date semantics (`occurredAt` arrives as
// an ISO string), so the consumer has to round-trip through a decoder
// that re-runs the same zod schema + value-object construction the relay
// did when it built the event from the outbox row. This matches the
// `decoderRegistry` pass `processOutboxEvents` uses for at-rest rows so
// downstream consumer code sees fully-typed `DomainEvent`s regardless
// of transport.
function parseEvent(
  body: string,
  registry: EventDecoderRegistry = defaultEventDecoderRegistry,
): DomainEvent {
  const raw = JSON.parse(body) as Readonly<{
    id?: unknown;
    type?: unknown;
    payload?: unknown;
    occurredAt?: unknown;
    aggregateId?: unknown;
  }>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.aggregateId !== "string" ||
    typeof raw.occurredAt !== "string"
  ) {
    throw new Error(
      "[queue] SQS body is missing required DomainEvent envelope fields",
    );
  }
  const decoder = (
    registry as Readonly<Record<string, EventDecoder<DomainEvent> | undefined>>
  )[raw.type];
  if (!decoder) {
    throw new Error(
      `[queue] no decoder registered for event type "${raw.type}"`,
    );
  }
  return decoder(raw.payload, {
    id: EventId.create(raw.id),
    occurredAt: new Date(raw.occurredAt),
    aggregateId: raw.aggregateId,
  });
}

/**
 * SQS consumer: runs the idempotency check + business projection. Returns
 * `batchItemFailures` so the Lambda service redrives only the failed
 * messages — requires `ReportBatchItemFailures` on the event source mapping.
 */
export async function handleQueue(event: SQSEvent): Promise<SQSBatchResponse> {
  const { container } = await getWorkerBoot();
  const failures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    let parsed: DomainEvent;
    try {
      parsed = parseEvent(record.body);
    } catch (cause) {
      container.logger.error(
        "[queue] failed to parse SQS body — leaving for redrive",
        { messageId: record.messageId, cause },
      );
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }

    try {
      const { alreadyProcessed } =
        await container.idempotencyStore.markProcessed(parsed.id);
      if (alreadyProcessed) {
        container.logger.info(
          `[queue] skipping redelivery of ${parsed.type} ${parsed.id}`,
          { eventId: parsed.id },
        );
        continue;
      }
      container.logger.info(`[queue] received ${parsed.type} ${parsed.id}`, {
        event: parsed,
      });
    } catch (cause) {
      container.logger.error(
        `[queue] handler failed for ${parsed.type} ${parsed.id}`,
        { eventId: parsed.id, cause },
      );
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

/**
 * DLQ handler: log only, never retry. The DLQ has no further dead-letter
 * target, so anything that surfaces as a failure (thrown error or non-empty
 * `batchItemFailures`) would loop on the same message until SQS retention
 * expires. Side effects added here must keep their own try/catch.
 */
export async function handleDlq(event: SQSEvent): Promise<SQSBatchResponse> {
  const { container } = await getWorkerBoot();
  for (const record of event.Records) {
    let parsed: DomainEvent | null = null;
    try {
      parsed = parseEvent(record.body);
    } catch {
      // Leave `parsed` null and log the raw body below.
    }
    if (parsed) {
      container.logger.error(
        `[dlq] event quarantined after retries: ${parsed.type} ${parsed.id}`,
        {
          eventId: parsed.id,
          eventType: parsed.type,
          messageId: record.messageId,
          approximateReceiveCount: record.attributes.ApproximateReceiveCount,
          event: parsed,
        },
      );
    } else {
      container.logger.error("[dlq] unparseable message quarantined", {
        messageId: record.messageId,
        body: record.body,
      });
    }
  }
  return { batchItemFailures: [] };
}

export function __resetWorkerBootForTests(): void {
  workerBootPromise = null;
}
