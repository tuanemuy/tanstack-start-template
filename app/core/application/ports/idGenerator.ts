import { v7 as uuidv7 } from "uuid";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Generator of opaque, stable, unique identifiers.
 *
 * Domain value objects (`TodoId`, `EventId`) treat the produced strings as
 * opaque non-empty values — they deliberately do not validate the
 * generator's format. The *format* (UUIDv7 in this template) is a
 * deployment-level decision owned by the implementation chosen here, and
 * storage adapters are responsible for re-validating that format when
 * rehydrating persisted ids back into the domain (see `isUuidV7`).
 *
 * Replacements (e.g. ULID, KSUID) need to be unique. They do not need to
 * be monotonic: `(createdAt, id)` only acts as a deterministic poll-order
 * tiebreaker for the outbox — consumers must NOT rely on observing events
 * in any particular order. When swapping the generator, also swap the
 * adapter-side validator paired with it.
 */
export interface IdGenerator {
  next(): string;
}

export const UuidV7Generator: IdGenerator = {
  next: () => uuidv7(),
};

/**
 * Format validator paired with `UuidV7Generator`. Storage adapters call
 * this on rehydration: a row whose id does not match indicates data
 * corruption (or a deployment mismatch) and is surfaced as a
 * `SystemError`. Domain-side `*Id.create` factories deliberately stay
 * format-agnostic — the canonical place to enforce UUIDv7 is here.
 */
export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}
