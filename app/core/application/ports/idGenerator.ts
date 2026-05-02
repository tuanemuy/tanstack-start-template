import { v7 as uuidv7 } from "uuid";

// `(createdAt, id)` only acts as a deterministic poll-order tiebreaker for
// the outbox — consumers must NOT rely on observing events in any
// particular order. Replacements need to be unique, not monotonic.
export interface IdGenerator {
  next(): string;
}

export const UuidV7Generator: IdGenerator = {
  next: () => uuidv7(),
};
