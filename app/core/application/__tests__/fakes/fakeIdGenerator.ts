import type { IdGenerator } from "@/core/application/ports/idGenerator";

/**
 * Deterministic in-memory `IdGenerator` for tests. Emits UUIDv7-shaped
 * strings with a synthetic prefix (`ffffffff-...`) chosen so generated ids
 * sort AFTER any plausible real UUIDv7 — real ones encode the current ms,
 * which keeps them well below this prefix until far in the future.
 */
export class FakeIdGenerator implements IdGenerator {
  private counter: number;

  constructor(start = 1) {
    this.counter = start;
  }

  next(): string {
    const n = this.counter;
    this.counter += 1;
    const tail = n.toString(16).padStart(12, "0");
    return `ffffffff-ffff-7fff-8fff-${tail}`;
  }

  reset(start = 1): void {
    this.counter = start;
  }
}
