import type { Logger } from "@repo/core/application/ports/logger";
import { describe, expect, it, vi } from "vitest";
import { createInProcessRelayTrigger } from "../inProcessRelayTrigger";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// `setImmediate` resolves after pending microtasks, so `Promise.resolve()` is
// enough to give the trigger one shot at observing a `kick`. A second
// `setImmediate` flush guarantees the queued tick (if any) has also been
// drained.
const flushImmediates = async (count = 2): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe("createInProcessRelayTrigger", () => {
  it("runs the tick on kick", async () => {
    const runTick = vi.fn(async () => {});
    const trigger = createInProcessRelayTrigger({
      runTick,
      logger: silentLogger,
    });

    trigger.kick();
    await flushImmediates();

    expect(runTick).toHaveBeenCalledTimes(1);
    await trigger.stop();
  });

  it("collapses concurrent kicks into a single re-run after the in-flight tick", async () => {
    let resolveFirstTick!: () => void;
    let started = 0;
    let resolveStarted!: () => void;
    const startedPromise = new Promise<void>((r) => {
      resolveStarted = r;
    });
    const runTick = vi.fn(async () => {
      started += 1;
      if (started === 1) {
        resolveStarted();
        await new Promise<void>((r) => {
          resolveFirstTick = r;
        });
      }
    });
    const trigger = createInProcessRelayTrigger({
      runTick,
      logger: silentLogger,
    });

    trigger.kick();
    await startedPromise;
    // 5 concurrent kicks while the first tick is in flight should
    // produce exactly one queued re-run, not 5.
    for (let i = 0; i < 5; i++) trigger.kick();
    expect(runTick).toHaveBeenCalledTimes(1);
    resolveFirstTick();
    await trigger.stop();
    expect(runTick).toHaveBeenCalledTimes(2);
  });

  it("stop() awaits the in-flight tick", async () => {
    let resolveTick!: () => void;
    let resolved = false;
    const runTick = vi.fn(async () => {
      await new Promise<void>((r) => {
        resolveTick = r;
      });
      resolved = true;
    });
    const trigger = createInProcessRelayTrigger({
      runTick,
      logger: silentLogger,
    });

    trigger.kick();
    await flushImmediates(1);
    const stopPromise = trigger.stop();
    // The tick is still in flight, so `stop()` must not resolve yet.
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await flushImmediates(1);
    expect(stopped).toBe(false);
    expect(resolved).toBe(false);

    resolveTick();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(resolved).toBe(true);
  });

  it("ignores kicks after stop()", async () => {
    const runTick = vi.fn(async () => {});
    const trigger = createInProcessRelayTrigger({
      runTick,
      logger: silentLogger,
    });
    await trigger.stop();
    trigger.kick();
    await flushImmediates();
    expect(runTick).not.toHaveBeenCalled();
  });

  it("logs and swallows a throwing tick", async () => {
    const error = vi.fn();
    const logger: Logger = { info: () => {}, warn: () => {}, error };
    const runTick = vi.fn(async () => {
      throw new Error("boom");
    });
    const trigger = createInProcessRelayTrigger({ runTick, logger });

    trigger.kick();
    await flushImmediates();
    await trigger.stop();

    expect(runTick).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
