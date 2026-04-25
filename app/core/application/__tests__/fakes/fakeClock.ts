import type { Clock } from "@/core/application/ports/clock";

/**
 * Deterministic in-memory `Clock` for unit tests.
 *
 * Construct with a fixed `Date` (or default to the unix epoch). `now()`
 * returns a defensive copy so a test that mutates the returned `Date` cannot
 * influence what subsequent calls observe — `Date` is unfortunately mutable
 * via setters, and a stray `setHours` could otherwise turn the fake into a
 * source of confusion.
 *
 * `set` and `advanceMs` let property/scenario tests fast-forward without
 * leaning on `vi.useFakeTimers`, which is heavier and global.
 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date = new Date(0)) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Replace the current time with a new fixed instant. */
  set(next: Date): void {
    this.current = new Date(next.getTime());
  }

  /** Advance the current time by `ms` milliseconds. */
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
