// Production launcher for the Node runtime.
//
// Plain ESM JavaScript (no TypeScript, no transpiler) so a production
// host can `node`-execute it without `tsx` — the counterpart of
// `listen.gcp.mjs`. `listen.node.ts` stays as the dev/tsx entry; this
// file is what process managers (pm2, systemd, …) should point at.
//
// Like every launcher in this repo, it reads `process.env` only — env
// injection is the invoker's job (`node --env-file-if-exists=.env`,
// pm2 `--node-args`, systemd `EnvironmentFile=`, …).
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

// The candidate is picked by existence, not by whether it imports —
// a bundle that exists but fails to load must surface its real error
// instead of a misleading "could not locate".
async function loadBundled() {
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `[listen.node] could not locate the bundled server entry. Tried:\n  - ${candidates.join("\n  - ")}\nDid you run \`pnpm build:node\`?`,
    );
  }
  const mod = await import(pathToFileURL(found).toString());
  const resolved = typeof mod.boot === "function" ? mod : mod.default;
  if (!resolved || typeof resolved.boot !== "function") {
    throw new Error(`[listen.node] ${found} does not export boot()`);
  }
  return resolved;
}

async function main() {
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
  const shutdown = async (signal) => {
    console.log(`[listen.node] received ${signal}, draining`);
    await new Promise((resolve, reject) => {
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
