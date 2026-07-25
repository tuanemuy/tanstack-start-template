import type { IdGenerator } from "@repo/core/application/ports/idGenerator";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Deterministic in-memory `IdGenerator` for tests. Emits UUIDv7-shaped
 * strings with a synthetic prefix (`ffffffff-...`) chosen so generated ids
 * sort AFTER any plausible real UUIDv7 — real ones encode the current ms,
 * which keeps them well below this prefix until far in the future.
 *
 * The `7fff` segment fixes the version nibble at `7` (UUIDv7); the `8fff`
 * segment fixes the variant nibble at `8` (RFC 4122 variant 10xx). Both
 * are required for `validate` to accept the output — the regex enforces
 * `7` for the version and `[89ab]` for the variant.
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

  validate(id: string): boolean {
    return UUID_V7_PATTERN.test(id);
  }

  reset(start = 1): void {
    this.counter = start;
  }
}
