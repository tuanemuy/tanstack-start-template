// Cloudflare Workers entry. This is the `main` referenced from
// `wrangler.toml` and unifies three handler types in one Worker:
//
//   - `fetch`     — TanStack Start's request handler (RSC + routes).
//   - `scheduled` — Cron Triggers fire the outbox relay (claim + dispatch
//                   to Queue) and a daily prune of processed rows.
//   - `queue`     — Queue Consumer drains the dispatched events to their
//                   subscribers.
//
// The relay design mirrors `app/core/application/workers/
// eventRelayWorker.ts`: the outbox is the durable record of what
// happened, and "dispatch" means "the message has been handed off to
// the durable transport". The Queue's own retry / DLQ semantics own
// everything downstream of that hand-off.
//
// `scheduled` and `queue` live in `app/worker/handlers.ts` so the
// Workers test suite can drive them without booting TanStack Start.
import { default as startEntry } from "@tanstack/react-start/server-entry";
import { handleQueue, handleScheduled } from "./worker/handlers";

export type { WorkerEnv } from "./worker/handlers";

// `satisfies ExportedHandler<WorkerEnv>` is intentionally NOT applied:
// TanStack Start's `fetch` types its `Request` against `lib.dom`, while
// `@cloudflare/workers-types` augments `Request` with `cf` properties.
// The two are runtime-compatible but do not unify under TS structural
// assignability. workerd duck-types the handler at boot, so this object
// shape is what matters at runtime.
export default {
  fetch: startEntry.fetch,
  scheduled: handleScheduled,
  queue: handleQueue,
};
