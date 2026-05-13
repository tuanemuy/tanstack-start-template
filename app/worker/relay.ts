import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import { type RelayEnv, runRelayTick } from "./handlers";

export type { RelayEnv } from "./handlers";

// Both entry points hand the tick to `ctx.waitUntil` and respond
// immediately. The cron in [env.relay] is the safety net; the fetch
// path is the Service Binding kick fired from the request path right
// after a UoW commit. Both call into the same `runRelayTick` so a
// single drain policy applies regardless of trigger.
export default {
  async fetch(
    _request: Request,
    env: RelayEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    ctx.waitUntil(runRelayTick(env));
    return new Response(null, { status: 202 });
  },
  async scheduled(
    _controller: ScheduledController,
    env: RelayEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runRelayTick(env));
  },
};
