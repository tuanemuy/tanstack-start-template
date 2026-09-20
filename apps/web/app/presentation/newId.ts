import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";

/**
 * Mints the id of an aggregate the client creates.
 *
 * Creating usecases take the id from the caller so a resend of the same
 * request is a replay rather than a second aggregate (see `createTodo`). They
 * check it with the `IdGenerator` their DI container wires, so this must be
 * that same generator.
 */
export function newId(): string {
  return UuidV7Generator.next();
}
