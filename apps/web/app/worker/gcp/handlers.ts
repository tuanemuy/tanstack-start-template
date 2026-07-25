import process from "node:process";
import { PubSub } from "@google-cloud/pubsub";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import type { Client } from "@libsql/client";
import { CloudRunRelayTrigger } from "@repo/core/adapters/gcp/cloudRunRelayTrigger";
import { createPubsubQueueDispatcher } from "@repo/core/adapters/gcp/pubsubQueueDispatcher";
import { loadSecretsIntoEnv } from "@repo/core/adapters/gcp/secretsLoader";
import {
  applyPragmas,
  createLibsqlClient,
  type Database,
  getDatabase,
} from "@repo/core/adapters/libsql/client";
import {
  createGcpWorkerContainer,
  type GcpServerEnv,
  readGcpServerEnv,
  readPruneTuning,
  readRelayTuning,
} from "@repo/core/application/di/serverGcp";
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
import { GoogleAuth } from "google-auth-library";

type WorkerBoot = Readonly<{
  env: GcpServerEnv;
  client: Client;
  db: Database;
  container: WorkerContainer;
}>;

let workerBootPromise: Promise<WorkerBoot> | null = null;

async function bootWorker(): Promise<WorkerBoot> {
  const secretName = process.env["DATABASE_AUTH_TOKEN_SECRET_NAME"];
  if (secretName !== undefined && secretName !== "") {
    await loadSecretsIntoEnv({
      client: new SecretManagerServiceClient(),
      bindings: [{ secretName, envVar: "DATABASE_AUTH_TOKEN" }],
    });
  }

  const env = readGcpServerEnv();
  const client = createLibsqlClient({
    url: env.DATABASE_URL,
    ...(env.DATABASE_AUTH_TOKEN !== undefined
      ? { authToken: env.DATABASE_AUTH_TOKEN }
      : {}),
  });
  const isMemory = env.DATABASE_URL === ":memory:";
  await applyPragmas(client, isMemory ? { wal: false } : {});
  const db = getDatabase(client);
  const container = createGcpWorkerContainer(db);
  return { env, client, db, container };
}

export function getWorkerBoot(): Promise<WorkerBoot> {
  if (workerBootPromise === null) {
    workerBootPromise = bootWorker().catch((cause) => {
      // Reset on failure so a transient Turso outage during boot can
      // recover on the next invocation.
      workerBootPromise = null;
      throw cause;
    });
  }
  return workerBootPromise;
}

let pubsubClientSingleton: PubSub | null = null;
function getPubsubClient(projectId: string | undefined): PubSub {
  if (pubsubClientSingleton === null) {
    pubsubClientSingleton =
      projectId !== undefined ? new PubSub({ projectId }) : new PubSub();
  }
  return pubsubClientSingleton;
}

let googleAuthSingleton: GoogleAuth | null = null;
function getGoogleAuth(): GoogleAuth {
  if (googleAuthSingleton === null) {
    googleAuthSingleton = new GoogleAuth();
  }
  return googleAuthSingleton;
}

let relaySelfTriggerSingleton: CloudRunRelayTrigger | null = null;
function getRelaySelfTrigger(
  relayUrl: string,
  logger: WorkerContainer["logger"],
): CloudRunRelayTrigger {
  if (relaySelfTriggerSingleton === null) {
    relaySelfTriggerSingleton = new CloudRunRelayTrigger({
      auth: getGoogleAuth(),
      relayUrl,
      logger,
    });
  }
  return relaySelfTriggerSingleton;
}

export async function runRelayTick(
  override?: ProcessOutboxEventsOptions,
): Promise<{ processed: number }> {
  const { env, container } = await getWorkerBoot();
  const topicName = env.EVENTS_TOPIC;
  if (topicName === undefined) {
    throw new Error(
      "[worker.gcp.relay] EVENTS_TOPIC is required for the relay service",
    );
  }
  const dispatcher = createPubsubQueueDispatcher({
    client: getPubsubClient(env.GCP_PROJECT_ID),
    topicName,
  });
  // `maxIterations` is resolved here (not just inside `processOutboxEvents`)
  // so the same value drives the saturation check below.
  const relayTuning = readRelayTuning(env);
  const tuning: ProcessOutboxEventsOptions = {
    batchSize: relayTuning.batchSize,
    leaseMs: relayTuning.leaseMs,
    maxAttempts: relayTuning.maxAttempts,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    ...override,
  };
  const result = await processOutboxEvents(container, dispatcher, tuning);

  // Self-chain when the tick drained a full `batchSize * maxIterations`:
  // more rows likely remain and waiting for the next 5-min scheduler
  // tick would let the backlog grow.
  const batchSize = tuning.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxIterations = tuning.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const looksDrainable = result.processed >= batchSize * maxIterations;
  if (looksDrainable && env.RELAY_URL !== undefined) {
    getRelaySelfTrigger(env.RELAY_URL, container.logger).kick();
  }

  return result;
}

export async function runPruneTick(
  override?: Partial<PruneOutboxOptions>,
): Promise<{ deleted: number }> {
  const { env, container } = await getWorkerBoot();
  return pruneOutbox(container, { ...readPruneTuning(env), ...override });
}

// Pub/Sub transport loses `Date` semantics (`occurredAt` arrives as an
// ISO string), so the consumer round-trips through the decoder registry
// to rehydrate value objects.
function parseEvent(
  payload: unknown,
  registry: EventDecoderRegistry = defaultEventDecoderRegistry,
): DomainEvent {
  const raw = payload as Readonly<{
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
      "[queue] Pub/Sub message is missing required DomainEvent envelope fields",
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

type PubsubPushEnvelope = Readonly<{
  message?: Readonly<{
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Readonly<Record<string, string>>;
  }>;
  subscription?: string;
}>;

function decodePushEnvelope(raw: unknown): {
  messageId: string;
  parsedBody: unknown;
  attributes: Readonly<Record<string, string>>;
} {
  if (raw === null || typeof raw !== "object") {
    throw new Error("[queue] Pub/Sub push envelope is not an object");
  }
  const envelope = raw as PubsubPushEnvelope;
  const message = envelope.message;
  if (
    message === undefined ||
    typeof message.data !== "string" ||
    typeof message.messageId !== "string"
  ) {
    throw new Error("[queue] Pub/Sub push envelope is missing required fields");
  }
  const decoded = Buffer.from(message.data, "base64").toString("utf8");
  return {
    messageId: message.messageId,
    parsedBody: JSON.parse(decoded),
    attributes: (message.attributes ?? {}) as Readonly<Record<string, string>>,
  };
}

export type QueueResponse = Readonly<{
  status: number;
  body?: string;
}>;

export async function handleQueue(envelope: unknown): Promise<QueueResponse> {
  const { container } = await getWorkerBoot();

  let messageId: string;
  let parsedBody: unknown;
  try {
    ({ messageId, parsedBody } = decodePushEnvelope(envelope));
  } catch (cause) {
    // Malformed envelopes never become well-formed via redelivery; ack.
    container.logger.error(
      "[queue] failed to decode Pub/Sub push envelope — acking to avoid loop",
      { cause },
    );
    return { status: 204 };
  }

  let parsed: DomainEvent;
  try {
    parsed = parseEvent(parsedBody);
  } catch (cause) {
    container.logger.error(
      "[queue] failed to parse Pub/Sub body — leaving for redrive",
      { messageId, cause },
    );
    return { status: 500, body: "parse failed" };
  }

  try {
    const { alreadyProcessed } = await container.idempotencyStore.markProcessed(
      parsed.id,
    );
    if (alreadyProcessed) {
      container.logger.info(
        `[queue] skipping redelivery of ${parsed.type} ${parsed.id}`,
        { eventId: parsed.id },
      );
      return { status: 204 };
    }
    container.logger.info(`[queue] received ${parsed.type} ${parsed.id}`, {
      event: parsed,
    });
    return { status: 204 };
  } catch (cause) {
    container.logger.error(
      `[queue] handler failed for ${parsed.type} ${parsed.id}`,
      { eventId: parsed.id, cause },
    );
    return { status: 500, body: "handler failed" };
  }
}

// INVARIANT: every path returns 204. The DLQ has no downstream
// dead-letter target — a non-2xx response makes Pub/Sub redeliver the
// same message until retention expires. Any side effect added here must
// have its own try/catch.
export async function handleDlq(envelope: unknown): Promise<QueueResponse> {
  const { container } = await getWorkerBoot();

  let messageId: string;
  let parsedBody: unknown;
  let attributes: Readonly<Record<string, string>>;
  try {
    ({ messageId, parsedBody, attributes } = decodePushEnvelope(envelope));
  } catch (cause) {
    container.logger.error(
      "[dlq] failed to decode Pub/Sub push envelope — acking",
      { cause },
    );
    return { status: 204 };
  }

  let parsed: DomainEvent | null = null;
  try {
    parsed = parseEvent(parsedBody);
  } catch {
    // Leave `parsed` null and log the raw body below.
  }
  if (parsed) {
    container.logger.error(
      `[dlq] event quarantined after retries: ${parsed.type} ${parsed.id}`,
      {
        eventId: parsed.id,
        eventType: parsed.type,
        messageId,
        deliveryAttempt: attributes["googclient_deliveryattempt"],
        event: parsed,
      },
    );
  } else {
    container.logger.error("[dlq] unparseable message quarantined", {
      messageId,
      body: parsedBody,
    });
  }
  return { status: 204 };
}

export function __resetWorkerBootForTests(): void {
  workerBootPromise = null;
  pubsubClientSingleton = null;
  googleAuthSingleton = null;
  relaySelfTriggerSingleton = null;
}
