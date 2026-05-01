/**
 * Application-layer port for obtaining the current wall-clock time.
 * Usecases call `container.clock.now()` once at the entry point and pass
 * the resulting `Date` into every domain operation that needs a timestamp.
 */
export interface Clock {
  now(): Date;
}

export const SystemClock: Clock = {
  now: () => new Date(),
};
