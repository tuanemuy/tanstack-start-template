import type { IdGenerator } from "@/core/application/ports/idGenerator";

/**
 * Deterministic in-memory `IdGenerator` for tests.
 *
 * Style choice: a counter that interpolates into a UUIDv7 *template* rather
 * than a plain integer. Two reasons:
 *
 * 1. Outputs must survive `TodoId.create`, which validates the UUIDv7 shape.
 *    A bare `"id-1"` string would fail that check, defeating the point of
 *    having a fake at all.
 * 2. A counter gives readable, ordered ids in failure messages
 *    (`...000000000001`, `...000000000002`) without requiring the test author
 *    to spell out a list of fixed ids up front. Tests that need specific ids
 *    can still pass them through `seed` to anchor the sequence.
 *
 * The template uses the variant nibble `8` and version nibble `7` so the
 * resulting strings match the UUIDv7 regex `TodoId.create` enforces.
 */
export class FakeIdGenerator implements IdGenerator {
  private counter: number;

  constructor(start = 1) {
    this.counter = start;
  }

  next(): string {
    const n = this.counter;
    this.counter += 1;
    // 12 hex digits in the trailing segment, zero-padded.
    const tail = n.toString(16).padStart(12, "0");
    // Prefix is a synthetic timestamp far past any plausible real UUIDv7
    // (real ones encode the current ms, so they are nowhere near `f0...`).
    // We want generated ids to sort AFTER any literal `01950000-...`-style
    // ids that tests insert directly, so `(createdAt, id)` ordering on the
    // outbox lands generated rows last when seconds tie. The version nibble
    // (`7` after the second hyphen) and variant nibble (`8` after the third)
    // satisfy `TodoId.create`'s UUIDv7 regex.
    return `f0000000-0000-7000-8000-${tail}`;
  }

  /** Reset the counter so the next `next()` call returns the seeded id. */
  reset(start = 1): void {
    this.counter = start;
  }
}
