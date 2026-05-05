import { v7 as uuidv7 } from "uuid";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Generator + format validator for opaque, stable, unique identifiers.
 *
 * Domain value objects (`TodoId`, `EventId`) treat the produced strings as
 * opaque non-empty values — they deliberately do not validate the
 * generator's format. The *format* (UUIDv7 in this template) is a
 * deployment-level decision owned by the implementation chosen here, and
 * storage adapters call `validate` on rehydration: a row whose id does
 * not match indicates data corruption (or a deployment mismatch) and is
 * surfaced as a `SystemError`. Pairing `next` and `validate` on the same
 * port keeps the generator and its rehydration check from drifting apart
 * when the implementation is swapped.
 *
 * Replacements (e.g. ULID, KSUID) need to be unique. They do not need to
 * be monotonic: `(createdAt, id)` only acts as a deterministic poll-order
 * tiebreaker for the outbox — consumers must NOT rely on observing events
 * in any particular order.
 */
export interface IdGenerator {
  next(): string;
  validate(id: string): boolean;
}

export const UuidV7Generator: IdGenerator = {
  next: () => uuidv7(),
  validate: (value) => UUID_V7_PATTERN.test(value),
};
