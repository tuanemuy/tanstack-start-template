import fs from "node:fs";
import path from "node:path";
import {
  applyPragmas,
  createLibsqlClient,
  getDatabase,
} from "@repo/core/adapters/libsql/client";
import {
  createNodeRequestContainer,
  readNodeRequestServerConfig,
} from "@repo/core/application/di/serverNode";
import type { RequestContainer } from "@repo/core/application/di/types";
import { z } from "zod";

/**
 * MCP-server env surface. An MCP server has no public URL, so `APP_URL` only feeds
 * config defaults and may be omitted.
 */
const mcpEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_AUTH_TOKEN: z.string().min(1).optional(),
  DATABASE_ENCRYPTION_KEY: z.string().min(1).optional(),
  APP_URL: z.string().min(1).default("http://localhost:3000"),
});

/**
 * Boot a request container for a long-lived MCP server process.
 *
 * Uses the Noop relay trigger: outbox rows written by mutations are
 * picked up by whichever runtime hosts the relay worker (`pnpm start`
 * of the web app in the Node runtime), not by this process.
 */
export async function createMcpContainer(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RequestContainer> {
  const env = mcpEnvSchema.parse(source);

  // libSQL's embedded driver fails to open a `file:` URL whose parent
  // directory does not exist; pre-create it so a fresh clone boots.
  if (env.DATABASE_URL.startsWith("file:")) {
    const filePath = env.DATABASE_URL.slice("file:".length);
    const parent = path.dirname(path.resolve(process.cwd(), filePath));
    fs.mkdirSync(parent, { recursive: true });
  }

  const client = createLibsqlClient({
    url: env.DATABASE_URL,
    ...(env.DATABASE_AUTH_TOKEN !== undefined
      ? { authToken: env.DATABASE_AUTH_TOKEN }
      : {}),
    ...(env.DATABASE_ENCRYPTION_KEY !== undefined
      ? { encryptionKey: env.DATABASE_ENCRYPTION_KEY }
      : {}),
  });
  const isMemory = env.DATABASE_URL === ":memory:";
  await applyPragmas(client, isMemory ? { wal: false } : {});
  const db = getDatabase(client);

  const config = readNodeRequestServerConfig(
    {
      DATABASE_URL: env.DATABASE_URL,
      DATABASE_AUTH_TOKEN: env.DATABASE_AUTH_TOKEN,
      DATABASE_ENCRYPTION_KEY: env.DATABASE_ENCRYPTION_KEY,
      APP_URL: env.APP_URL,
    },
    { db },
  );
  return createNodeRequestContainer(config);
}
