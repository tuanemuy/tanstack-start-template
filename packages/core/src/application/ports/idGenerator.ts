import { v7 as uuidv7 } from "uuid";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare const generatedIdBrand: unique symbol;

/**
 * An id the wired generator minted, or one `parse` accepted as such.
 *
 * Usecases that persist a caller-chosen id take this instead of `string`, so
 * an id the adapters would refuse to rehydrate cannot reach them: every
 * transport has to go through `parse` to obtain one.
 */
export type GeneratedId = string & { readonly [generatedIdBrand]: true };

/**
 * Generator + format parser for opaque, stable, unique identifiers.
 *
 * Domain value objects (`TodoId`, `EventId`) treat the produced strings as
 * opaque non-empty values — they deliberately do not validate the
 * generator's format. The *format* (UUIDv7 in this template) is a
 * deployment-level decision owned by the implementation chosen here, and
 * storage adapters call `parse` on rehydration: a row whose id does
 * not match indicates data corruption (or a deployment mismatch) and is
 * surfaced as a `SystemError`. Pairing `next` and `parse` on the same
 * port keeps the generator and its format check from drifting apart
 * when the implementation is swapped.
 *
 * Replacements (e.g. ULID, KSUID) need to be unique. They do not need to
 * be monotonic: `(createdAt, id)` only acts as a deterministic poll-order
 * tiebreaker for the outbox — consumers must NOT rely on observing events
 * in any particular order.
 */
export interface IdGenerator {
  next(): GeneratedId;
  parse(raw: string): GeneratedId | null;
}

export const UuidV7Generator: IdGenerator = {
  next: () => uuidv7() as GeneratedId,
  parse: (raw) => (UUID_V7_PATTERN.test(raw) ? (raw as GeneratedId) : null),
};
