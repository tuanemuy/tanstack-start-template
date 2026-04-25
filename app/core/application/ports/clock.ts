/**
 * Application-layer port for obtaining the current wall-clock time.
 *
 * Convention:
 *
 * - **Application layer** (this port's only consumer): usecases call
 *   `container.clock.now()` once at the entry point and pass the resulting
 *   `Date` into every domain operation that needs a timestamp. Within a single
 *   usecase invocation, every state mutation that should "happen at the same
 *   instant" reads from the same captured `Date`.
 * - **Domain layer**: factory / behaviour methods take `now: Date` as a
 *   required argument. They never reach for a Clock — the responsibility for
 *   resolving "what time is it?" belongs to the caller. This keeps the domain
 *   pure: no ambient I/O, deterministic in tests, no hidden time dependency.
 * - **Tests**: substitute a deterministic `FakeClock` that returns a fixed
 *   `Date` (or advances on demand) so the suite is reproducible.
 */
export interface Clock {
  now(): Date;
}

/**
 * Production `Clock` implementation backed by `new Date()`.
 */
export const SystemClock: Clock = {
  now: () => new Date(),
};
