/**
 * Port for obtaining the current wall-clock time.
 *
 * Domain entities and value objects MUST NOT call `new Date()` directly:
 * doing so makes them depend on ambient I/O (the system clock), which breaks
 * referential transparency, makes property-based tests non-deterministic,
 * and makes "what timestamp did this aggregate get?" untraceable from a
 * test setup.
 *
 * The convention is:
 *
 * - **Domain layer**: factory / behaviour methods take `now: Date` as a
 *   required argument. They never reach for a Clock themselves — the
 *   responsibility for resolving "what time is it?" belongs to the caller.
 * - **Application layer**: usecases pull a `Clock` off the container and
 *   call `clock.now()` once at the entry point, then pass the resulting
 *   `Date` down into every domain operation that needs it. Within a single
 *   usecase invocation, every state mutation that should "happen at the
 *   same instant" reads from the same captured `Date`.
 * - **Tests**: substitute a deterministic `FakeClock` that returns a fixed
 *   `Date` (or advances on demand) so the suite is reproducible.
 */
export interface Clock {
  now(): Date;
}

/**
 * Production-ready `Clock` implementation backed by `new Date()`.
 *
 * Exposed as a plain singleton object — there is no per-instance state to
 * close over, so a class would just add ceremony.
 */
export const SystemClock: Clock = {
  now: () => new Date(),
};
