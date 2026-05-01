import { v7 as uuidv7 } from "uuid";

// UUIDv7 monotonic ordering is what the outbox `(createdAt, id)` ordering
// relies on — replacements must preserve that property.
export interface IdGenerator {
  next(): string;
}

export const UuidV7Generator: IdGenerator = {
  next: () => uuidv7(),
};
