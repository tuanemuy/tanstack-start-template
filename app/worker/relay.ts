// Standalone relay Worker. Deploys independently of the TanStack
// Start fetch Worker — the two share the same `app/worker/handlers.ts`
// implementations but ship as separate units so a) the relay can be
// scaled / observed independently of the request path, and b) it
// avoids being gated on the main app's build pipeline.
//
// Use the dedicated `wrangler.relay.toml` to deploy this entry.
import { handleQueue, handleScheduled } from "./handlers";

export type { WorkerEnv } from "./handlers";

// No `fetch` handler: this Worker has nothing to serve over HTTP. Both
// `scheduled` (Cron Triggers) and `queue` (Queue Consumer) are wired.
export default {
  scheduled: handleScheduled,
  queue: handleQueue,
};
