// Loads the bundled server entry from `dist/server/server.node.js` and
// serves its fetch handler via `@hono/node-server`. Kept separate from
// `app/server.node.ts` so vite dev doesn't double-listen on a port.
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../.env"), quiet: true });

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

async function loadBundled(): Promise<BundledServerModule> {
  for (const candidate of candidates) {
    try {
      const mod = (await import(pathToFileURL(candidate).toString())) as
        | BundledServerModule
        | { default?: BundledServerModule };
      const resolved =
        "boot" in mod
          ? (mod as BundledServerModule)
          : (mod.default as BundledServerModule | undefined);
      if (resolved && typeof resolved.boot === "function") {
        return resolved;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `[listen.node] could not locate the bundled server entry. Tried:\n  - ${candidates.join("\n  - ")}\nDid you run \`pnpm build:node\`?`,
  );
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
