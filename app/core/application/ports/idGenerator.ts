import { v7 as uuidv7 } from "uuid";

/**
 * Application-layer port for minting fresh aggregate / event ids.
 *
 * Mirrors the {@link Clock} pattern: usecases call `container.idGenerator.next()`
 * at the entry point and pass the resulting string into every domain
 * construction that needs a fresh identifier (the aggregate factory, each
 * emitted event). The domain layer never sees the port — only the resolved
 * string — so domain code stays pure and deterministic under test.
 *
 * Rationale for promoting id minting to a port (rather than leaving
 * `uuidv7()` calls scattered through the domain): "what time is it?" and
 * "what is a fresh id?" are both forms of ambient I/O, and the project's
 * convention is that ambient I/O lives behind a port. Keeping the two rules
 * consistent removes the cognitive split where time was clock-injected but
 * ids were free to call `uuidv7()` inline.
 */
export interface IdGenerator {
  /**
   * Produce a fresh identifier suitable for use as an aggregate id, event
   * id, or any other internal key. Implementations MUST return values that
   * survive `TodoId.create` (and any other id factory the domain exposes) —
   * in practice this means returning UUIDv7 strings.
   */
  next(): string;
}

/**
 * Production `IdGenerator` backed by `uuid` v7. Keeps monotonic time-ordered
 * uniqueness, which the outbox `(createdAt, id)` ordering relies on.
 */
export const UuidV7Generator: IdGenerator = {
  next: () => uuidv7(),
};
