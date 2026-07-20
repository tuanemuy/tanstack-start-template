import { EventId } from "@repo/core/domain/common/event";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContainer, type TestContainer } from "./helpers";

let counter = 0;
const nextEventId = (): EventId => {
  counter += 1;
  return EventId.create(
    `0193e7d0-${counter.toString(16).padStart(4, "0")}-7000-9000-700000000000`,
  );
};

describe("LibsqlIdempotencyStore", () => {
  let container: TestContainer | null = null;
  const openContainer = async () => {
    container = await createTestContainer();
    return container;
  };
  afterEach(() => {
    container?.close();
    container = null;
  });

  it("returns alreadyProcessed=false on first claim and true on subsequent claims", async () => {
    const c = await openContainer();
    const id = nextEventId();

    const first = await c.idempotencyStore.markProcessed(id);
    expect(first.alreadyProcessed).toBe(false);

    const second = await c.idempotencyStore.markProcessed(id);
    expect(second.alreadyProcessed).toBe(true);

    const third = await c.idempotencyStore.markProcessed(id);
    expect(third.alreadyProcessed).toBe(true);
  });

  it("treats different event ids independently", async () => {
    const c = await openContainer();
    const a = nextEventId();
    const b = nextEventId();

    expect((await c.idempotencyStore.markProcessed(a)).alreadyProcessed).toBe(
      false,
    );
    expect((await c.idempotencyStore.markProcessed(b)).alreadyProcessed).toBe(
      false,
    );
    expect((await c.idempotencyStore.markProcessed(a)).alreadyProcessed).toBe(
      true,
    );
    expect((await c.idempotencyStore.markProcessed(b)).alreadyProcessed).toBe(
      true,
    );
  });

  it("serialises concurrent claims on the same id — exactly one wins", async () => {
    const c = await openContainer();
    const id = nextEventId();

    const results = await Promise.all([
      c.idempotencyStore.markProcessed(id),
      c.idempotencyStore.markProcessed(id),
      c.idempotencyStore.markProcessed(id),
    ]);
    const winners = results.filter((r) => !r.alreadyProcessed);
    expect(winners).toHaveLength(1);
  });
});
