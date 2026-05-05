// Outbox pruner Worker. Sole responsibility: delete long-since-
// processed outbox rows on a daily cron.
//
// Deploys via `wrangler.pruner.toml`. Has only the D1 binding — no
// Queue producer or consumer is needed for pruning.
import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { type PrunerEnv, runPruneTick } from "./handlers";

export type { PrunerEnv } from "./handlers";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: PrunerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runPruneTick(env));
  },
};
