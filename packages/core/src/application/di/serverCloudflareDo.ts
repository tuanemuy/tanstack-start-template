// DI wiring for the Durable-Object-based Cloudflare runtime. Kept
// separate from `./serverCloudflare.ts` (the shared-D1 topology) so
// each entry pulls only its own adapter graph; both return the same
// container shapes where the roles overlap.
//
// This runtime has no relay / pruner Workers and no relay trigger:
// the todo-state DO owns the outbox and relays it from its own alarm.
// The only sibling roles left are the queue consumer and the DLQ.
import { DoIdempotencyStore } from "@repo/core/adapters/do/idempotencyStore";
import type { TodoStateClient } from "@repo/core/adapters/do/protocol";
import { DoUnitOfWorkProvider } from "@repo/core/adapters/do/unitOfWork";
import { content } from "@repo/core/config";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import type { AppConfig, RequestContainer, SharedDeps } from "./types";

export {
  type ContainerStore,
  installContainerStore,
} from "./containerStore";
export {
  type PruneTuning,
  type RelayTuning,
  readPruneTuning,
  readRelayTuning,
  type TuningEnv,
} from "./env";
export type { AppConfig, RequestContainer, SharedDeps } from "./types";

export type DoRequestServerConfig = AppConfig &
  Readonly<{
    client: TodoStateClient;
  }>;

export function readDoRequestServerConfig(
  env: Readonly<{ APP_URL: string }>,
  client: TodoStateClient,
): DoRequestServerConfig {
  return {
    ...content,
    appUrl: env.APP_URL,
    client,
  };
}

function buildSharedDeps(): SharedDeps {
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

export function createDoRequestContainer(
  config: DoRequestServerConfig,
): RequestContainer {
  const { client, ...appConfig } = config;
  return {
    ...buildSharedDeps(),
    config: appConfig satisfies AppConfig,
    unitOfWorkProvider: new DoUnitOfWorkProvider(client, UuidV7Generator),
  };
}

/**
 * Consumer/DLQ container. Narrower than the shared `WorkerContainer`
 * on purpose: in this topology the outbox is reachable only inside the
 * DO, so worker-side code gets no `outboxRepository` — a consumer that
 * needs outbox access is a design smell here, and the type makes it
 * unrepresentable.
 */
export type DoConsumerContainer = SharedDeps &
  Readonly<{
    idempotencyStore: DoIdempotencyStore;
  }>;

export function createDoConsumerContainer(
  client: Pick<TodoStateClient, "markEventProcessed">,
): DoConsumerContainer {
  return {
    ...buildSharedDeps(),
    idempotencyStore: new DoIdempotencyStore(client),
  };
}
