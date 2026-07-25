import type { DomainEvent, EventDecoder } from "@repo/core/domain/common/event";
import type { z } from "zod";
import { SystemError, SystemErrorCode } from "../errors";

/**
 * Build an `EventDecoder` from a Zod schema + payload rehydration.
 *
 * Each domain decoder boils down to three things:
 *   1. assert wire shape (handled by `schema` — use `.strict()` to reject extras)
 *   2. throw `SystemError(DataIntegrityError)` on shape mismatch (handled here)
 *   3. rehydrate brand types from primitives (handled by `rehydrate`)
 *
 * The `meta` (id / occurredAt / aggregateId) is forwarded as-is from the
 * authoritative outbox row — payload is not consulted for those.
 */
export function buildEventDecoder<TEvent extends DomainEvent, TParsed>(
  type: TEvent["type"],
  schema: z.ZodType<TParsed>,
  rehydrate: (parsed: TParsed) => TEvent["payload"],
): EventDecoder<TEvent> {
  return (payload, meta) => {
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new SystemError(
        SystemErrorCode.DataIntegrityError,
        `Invalid payload for ${type}: ${result.error.message}`,
      );
    }
    return {
      id: meta.id,
      occurredAt: meta.occurredAt,
      aggregateId: meta.aggregateId,
      type,
      payload: rehydrate(result.data),
    } as TEvent;
  };
}
