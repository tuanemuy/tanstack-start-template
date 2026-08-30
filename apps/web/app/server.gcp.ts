// Cloud Run entry. One bundle, five roles — `boot()` dispatches on
// `WORKER_ROLE`. See `docs/runtime_gcp.md` for the role table.
import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { CloudRunRelayTrigger } from "@repo/core/adapters/gcp/cloudRunRelayTrigger";
import { loadSecretsIntoEnv } from "@repo/core/adapters/gcp/secretsLoader";
import {
  applyPragmas,
  createLibsqlClient,
  getDatabase,
} from "@repo/core/adapters/libsql/client";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import {
  createGcpRequestContainer,
  type GcpServerEnv,
  readGcpRequestServerConfig,
  readGcpServerEnv,
} from "@repo/core/application/di/serverGcp";
import type { RequestContainer } from "@repo/core/application/di/types";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { GoogleAuth } from "google-auth-library";
import { fetch as consumerFetch } from "@/worker/gcp/consumer";
import { fetch as dlqFetch } from "@/worker/gcp/dlq";
import { fetch as prunerFetch } from "@/worker/gcp/pruner";
import { fetch as relayFetch } from "@/worker/gcp/relay";

const ALS_SYMBOL: unique symbol = Symbol.for(
  "@tanstack-start-template/request-als",
) as never;
type AlsHotData = { als?: AsyncLocalStorage<RequestContainer> };
type AlsGlobalSlot = { [ALS_SYMBOL]?: AsyncLocalStorage<RequestContainer> };
const alsHotData: AlsHotData = (import.meta.hot?.data ?? {}) as AlsHotData;
const alsGlobal = globalThis as unknown as AlsGlobalSlot;
const storage =
  alsGlobal[ALS_SYMBOL] ??
  alsHotData.als ??
  new AsyncLocalStorage<RequestContainer>();
alsGlobal[ALS_SYMBOL] = storage;
if (import.meta.hot) {
  (import.meta.hot.data as AlsHotData).als = storage;
}
installContainerStore({ getStore: () => storage.getStore() });

export type AppEnv = GcpServerEnv;

export type WorkerRole = "app" | "relay" | "consumer" | "pruner" | "dlq";

const workerRoles: ReadonlySet<WorkerRole> = new Set([
  "app",
  "relay",
  "consumer",
  "pruner",
  "dlq",
]);

function resolveWorkerRole(): WorkerRole {
  const raw = process.env["WORKER_ROLE"];
  if (raw === undefined || raw === "") return "app";
  if (!workerRoles.has(raw as WorkerRole)) {
    throw new Error(
      `[server.gcp] unknown WORKER_ROLE "${raw}" (expected one of: ${[...workerRoles].join(", ")})`,
    );
  }
  return raw as WorkerRole;
}

export type GcpServerBoot = Readonly<{
  role: WorkerRole;
  fetch: (request: Request) => Promise<Response>;
  port: number;
  hostname: string;
  shutdown: () => Promise<void>;
}>;

async function bootAppRole(): Promise<GcpServerBoot> {
  const secretName = process.env["DATABASE_AUTH_TOKEN_SECRET_NAME"];
  if (secretName !== undefined && secretName !== "") {
    await loadSecretsIntoEnv({
      client: new SecretManagerServiceClient(),
      bindings: [{ secretName, envVar: "DATABASE_AUTH_TOKEN" }],
    });
  }

  const env = readGcpServerEnv();
  const logger = ConsoleLogger;

  const client = createLibsqlClient({
    url: env.DATABASE_URL,
    ...(env.DATABASE_AUTH_TOKEN !== undefined
      ? { authToken: env.DATABASE_AUTH_TOKEN }
      : {}),
  });
  const isMemory = env.DATABASE_URL === ":memory:";
  await applyPragmas(client, isMemory ? { wal: false } : {});
  const db = getDatabase(client);

  const config = readGcpRequestServerConfig(env, {
    db,
    ...(env.RELAY_URL !== undefined
      ? {
          relayTrigger: new CloudRunRelayTrigger({
            auth: new GoogleAuth(),
            relayUrl: env.RELAY_URL,
            logger,
          }),
        }
      : {}),
  });

  const entryPromise = import("@tanstack/react-start/server-entry").then(
    (m) => m.default,
  );

  // Pruning is NOT routed here: the app service carries an `allUsers`
  // invoker, so any path it serves is effectively public regardless of
  // which service accounts also hold `roles/run.invoker`. The pruner is
  // its own Cloud Run service (WORKER_ROLE=pruner) with no public
  // binding, gated by IAM exactly like the relay.
  const fetch = async (request: Request): Promise<Response> => {
    const container = createGcpRequestContainer(config);
    const entry = await entryPromise;
    return storage.run(container, async () => entry.fetch(request));
  };

  const port = Number.parseInt(process.env["PORT"] ?? "8080", 10);
  const hostname = process.env["HOSTNAME"] ?? "0.0.0.0";

  let shuttingDown: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown !== null) return shuttingDown;
    shuttingDown = (async () => {
      try {
        client.close();
      } catch (cause) {
        logger.error("[server.gcp] libsql client close threw", { cause });
      }
    })();
    return shuttingDown;
  };

  return { role: "app", fetch, port, hostname, shutdown };
}

function bootWorkerRole(role: Exclude<WorkerRole, "app">): GcpServerBoot {
  const fetch =
    role === "relay"
      ? relayFetch
      : role === "consumer"
        ? consumerFetch
        : role === "pruner"
          ? prunerFetch
          : dlqFetch;
  const port = Number.parseInt(process.env["PORT"] ?? "8080", 10);
  const hostname = process.env["HOSTNAME"] ?? "0.0.0.0";
  return { role, fetch, port, hostname, shutdown: async () => {} };
}

export async function boot(): Promise<GcpServerBoot> {
  const role = resolveWorkerRole();
  if (role === "app") return bootAppRole();
  return bootWorkerRole(role);
}

const defaultExport = {
  async fetch(request: Request): Promise<Response> {
    const booted = await getOrStartBoot();
    return booted.fetch(request);
  },
};

let bootPromise: Promise<GcpServerBoot> | null = null;
function getOrStartBoot(): Promise<GcpServerBoot> {
  if (bootPromise === null) {
    bootPromise = boot();
    const onSignal = (signal: NodeJS.Signals) => {
      ConsoleLogger.info(`[server.gcp] received ${signal}, shutting down`);
      void bootPromise?.then((b) => b.shutdown());
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  }
  return bootPromise;
}

export default defaultExport;
