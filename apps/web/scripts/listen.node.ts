// Loads the bundled server entry from `dist/server/server.node.js` and
// serves its fetch handler via `@hono/node-server`. Kept separate from
// `app/server.node.ts` so vite dev doesn't double-listen on a port.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";

const here = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
  path.resolve(here, "../dist/server/server.node.js"),
  path.resolve(here, "../server/server.node.js"),
  path.resolve(process.cwd(), "dist/server/server.node.js"),
];

type BootedServer = Readonly<{
  fetch: (request: Request) => Promise<Response>;
  port: number;
  hostname: string;
  shutdown: () => Promise<void>;
}>;

type BundledServerModule = Readonly<{
  boot: () => Promise<BootedServer>;
}>;

// The candidate is picked by existence, not by whether it imports —
// a bundle that exists but fails to load must surface its real error
// instead of a misleading "could not locate".
async function loadBundled(): Promise<BundledServerModule> {
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `[listen.node] could not locate the bundled server entry. Tried:\n  - ${candidates.join("\n  - ")}\nDid you run \`pnpm build:node\`?`,
    );
  }
  const mod = (await import(pathToFileURL(found).toString())) as
    | BundledServerModule
    | { default?: BundledServerModule };
  const resolved =
    "boot" in mod
      ? (mod as BundledServerModule)
      : (mod.default as BundledServerModule | undefined);
  if (!resolved || typeof resolved.boot !== "function") {
    throw new Error(`[listen.node] ${found} does not export boot()`);
  }
  return resolved;
}

async function main(): Promise<void> {
  const { boot } = await loadBundled();
  const booted = await boot();

  const server = serve(
    {
      fetch: booted.fetch,
      port: booted.port,
      hostname: booted.hostname,
    },
    (info) => {
      console.log(
        `[listen.node] listening on http://${info.address}:${info.port}`,
      );
    },
  );

  // These signal handlers run before `server.node.ts`'s own (which act
  // as a safety net) because `process.once` fires in registration order.
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[listen.node] received ${signal}, draining`);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await booted.shutdown();
    process.exit(0);
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main().catch((cause) => {
  console.error("[listen.node] failed to start", cause);
  process.exit(1);
});
