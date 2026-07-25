// Production launcher for the GCP Cloud Run image.
//
// Plain ESM JavaScript (no TypeScript, no transpiler) so the Cloud Run
// runtime image can `node`-execute it without pulling `tsx` into
// production dependencies. Node ≥22 is assumed (the Dockerfile pins
// `node:22-slim`).
//
// `.env` files are intentionally NOT loaded here:
//   - Cloud Run / Pub/Sub deployments inject env vars via
//     `--set-env-vars` and Secret Manager bindings.
//   - For local container runs, pass `--env-file=apps/web/.env.gcp` to
//     `docker run`, or use Node 22's built-in `node --env-file=...`.
//
// The launcher loads `dist/server/server.gcp.js` (the bundle vite
// produces), picks the role from `WORKER_ROLE`, and serves the
// resulting fetch handler via `@hono/node-server`.
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";

const here = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
  path.resolve(here, "../dist/server/server.gcp.js"),
  path.resolve(here, "../server/server.gcp.js"),
  path.resolve(process.cwd(), "dist/server/server.gcp.js"),
];

async function loadBundled() {
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).toString());
      const resolved = typeof mod.boot === "function" ? mod : mod.default;
      if (resolved && typeof resolved.boot === "function") {
        return resolved;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `[listen.gcp] could not locate the bundled server entry. Tried:\n  - ${candidates.join("\n  - ")}\nDid you run \`pnpm build:gcp\`?`,
  );
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
        `[listen.gcp] role=${booted.role} listening on http://${info.address}:${info.port}`,
      );
    },
  );

  const shutdown = async (signal) => {
    console.log(`[listen.gcp] received ${signal}, draining`);
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
  console.error("[listen.gcp] failed to start", cause);
  process.exit(1);
});
