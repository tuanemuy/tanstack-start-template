// Relay producer Worker. Sole responsibility: claim pending outbox
// rows on a 1-minute cron and publish them to the events Queue.
//
// Deploys via `wrangler.relay.toml`. Has D1 (read/update outbox) and
// Queue producer bindings — nothing else.
import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { type RelayEnv, runRelayTick } from "./handlers";

export type { RelayEnv } from "./handlers";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: RelayEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Single-cron Worker: no `controller.cron` switch is needed.
    ctx.waitUntil(runRelayTick(env));
  },
};
