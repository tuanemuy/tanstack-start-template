// Main app Worker — TanStack Start fetch handler only.
//
// Cron / Queue responsibilities are intentionally NOT here: they ship
// as separate Workers (relay producer, queue consumer, outbox pruner)
// each with its own `wrangler.*.toml`. One Worker per responsibility
// gives independent failure isolation, per-Worker observability, and
// least-privilege bindings.
//
// Deploy via `wrangler.toml`. Currently gated on the project's
// pre-existing client-bundle build issue (`pnpm build` fails before
// the libSQL adapter is excluded from the browser graph) — fix that
// first, then `pnpm deploy` ships this Worker.
import { default as startEntry } from "@tanstack/react-start/server-entry";
import type { D1Env } from "@/core/application/di/d1";

export type AppEnv = D1Env;

// `satisfies ExportedHandler<AppEnv>` is intentionally not applied:
// TanStack Start's `fetch` types its `Request` against `lib.dom`, while
// `@cloudflare/workers-types` augments `Request` with `cf` properties.
// The two are runtime-compatible but do not unify under TS structural
// assignability. workerd duck-types the handler at boot, so this
// object shape is what matters at runtime.
export default {
  fetch: startEntry.fetch,
};
