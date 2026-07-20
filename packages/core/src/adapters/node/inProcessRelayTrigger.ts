import type { Logger } from "@repo/core/application/ports/logger";
import type { RelayTrigger } from "@repo/core/application/ports/relayTrigger";

export type InProcessRelayTriggerDeps = Readonly<{
  runTick: () => Promise<void>;
  logger: Logger;
}>;

/**
 * Node {@link RelayTrigger}: `kick()` defers `runTick` via `setImmediate`.
 * At most one tick is in flight; concurrent kicks collapse into a single
 * queued re-run. `stop()` blocks new kicks and awaits the drain so
 * shutdown can sequence "stop intake → finish work → close DB".
 */
export type InProcessRelayTrigger = RelayTrigger & {
  stop(): Promise<void>;
};

export function createInProcessRelayTrigger(
  deps: InProcessRelayTriggerDeps,
): InProcessRelayTrigger {
  const { runTick, logger } = deps;

  let inFlight: Promise<void> | null = null;
  let pending = false;
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    try {
      await runTick();
    } catch (cause) {
      logger.error("[relay-trigger] in-process tick threw", { cause });
    }
  };

  const startLoop = (): Promise<void> => {
    const loop = (async () => {
      // Collapse repeated kicks while a tick is in flight into one re-run.
      while (true) {
        await runOnce();
        if (!pending) break;
        pending = false;
      }
    })();
    inFlight = loop.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    kick(): void {
      if (stopped) return;
      if (inFlight !== null) {
        pending = true;
        return;
      }
      setImmediate(() => {
        if (stopped) return;
        if (inFlight !== null) {
          pending = true;
          return;
        }
        void startLoop();
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      if (inFlight !== null) {
        await inFlight;
      }
    },
  };
}
