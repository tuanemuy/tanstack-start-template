/**
 * Best-effort kick of the outbox relay so newly-persisted events
 * publish without waiting for the safety-net cron.
 *
 * Contract:
 *   - Fire-and-forget: implementations MUST NOT throw and MUST NOT
 *     block the calling usecase. A failed kick is a latency degradation
 *     (the cron picks the rows up on the next tick), not a correctness
 *     problem.
 *   - Idempotent: a kick that loses the race with a concurrent run on
 *     the relay worker is a no-op — the relay claims rows under a lease.
 *   - Detached lifetime: implementations should arrange for the kick to
 *     outlive the request (e.g. via `ExecutionContext.waitUntil`) so the
 *     outgoing request is not cancelled when the response is sent.
 */
export interface RelayTrigger {
  kick(): void;
}

export const NoopRelayTrigger: RelayTrigger = {
  kick: () => {},
};
