import { type DomainEvent, EventId } from "@repo/core/domain/common/event";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryQueueDispatcher } from "../inMemoryQueueDispatcher";

let counter = 0;
const nextEventId = (): EventId => {
  counter += 1;
  return EventId.create(
    `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-9000-a00000000000`,
  );
};

const makeEvent = (): DomainEvent => ({
  id: nextEventId(),
  type: "test.event",
  payload: {},
  occurredAt: new Date(),
  aggregateId: "agg-1",
});

describe("createInMemoryQueueDispatcher", () => {
  it("returns success outcomes when the handler resolves", async () => {
    const handler = vi.fn(async () => {});
    const dispatch = createInMemoryQueueDispatcher({ handler });
    const events = [makeEvent(), makeEvent()];

    const outcomes = await dispatch(events);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(2);
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const outcome = outcomes[i];
      if (event === undefined || outcome === undefined) throw new Error("oob");
      expect(outcome.kind).toBe("success");
      expect(outcome.id).toBe(event.id);
    }
  });

  it("returns a failure outcome when the handler throws", async () => {
    const error = new Error("boom");
    const handler = vi.fn(async () => {
      throw error;
    });
    const dispatch = createInMemoryQueueDispatcher({ handler });
    const event = makeEvent();

    const outcomes = await dispatch([event]);

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    if (outcome === undefined) throw new Error("missing outcome");
    expect(outcome.kind).toBe("failure");
    expect(outcome.id).toBe(event.id);
    if (outcome.kind !== "failure") throw new Error("not failure");
    expect(outcome.error).toBe(error);
  });

  it("returns an empty list for an empty batch", async () => {
    const handler = vi.fn(async () => {});
    const dispatch = createInMemoryQueueDispatcher({ handler });
    const outcomes = await dispatch([]);
    expect(outcomes).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("respects the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const handler = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    const dispatch = createInMemoryQueueDispatcher({
      handler,
      concurrency: 2,
    });
    const events = Array.from({ length: 6 }, makeEvent);
    const outcomes = await dispatch(events);

    expect(handler).toHaveBeenCalledTimes(6);
    expect(outcomes).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
