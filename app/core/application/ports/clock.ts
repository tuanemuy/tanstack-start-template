export interface Clock {
  now(): Date;
}

export const SystemClock: Clock = {
  now: () => new Date(),
};
