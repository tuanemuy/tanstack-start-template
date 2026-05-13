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
