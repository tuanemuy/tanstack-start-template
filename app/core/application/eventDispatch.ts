import type {
  DomainEvent,
  EventDecodeMeta,
  EventDecoder,
} from "@/core/domain/common/event";
import { SystemError, SystemErrorCode } from "./error";

export type EventDecodeInput = Readonly<{
  type: string;
  payload: Record<string, unknown>;
  meta: EventDecodeMeta;
}>;

/**
 * Maps an event-type prefix (the token before the first `.`, e.g. `"todo"`
 * for `"todo.created"`) to the decoder that owns that domain's events.
 *
 * Strict by design: events whose prefix has no registered decoder are
 * rejected rather than passed through raw, because a silent passthrough
 * would let a typo'd event type reach dispatchers that expect branded
 * payloads.
 */
export type EventDecoderRegistry = Readonly<{
  decode: (entry: EventDecodeInput) => DomainEvent;
}>;

function prefixOf(type: string): string {
  const dot = type.indexOf(".");
  return dot < 0 ? type : type.slice(0, dot);
}

/**
 * Build a strict decoder registry. Call sites register each domain's decoder
 * explicitly — no dynamic imports, no import-time side effects — so the
 * wiring is grep-able.
 */
export function createEventDecoderRegistry(
  entries: Readonly<Record<string, EventDecoder>>,
): EventDecoderRegistry {
  return {
    decode: ({ type, payload, meta }) => {
      const decoder = entries[prefixOf(type)];
      if (!decoder) {
        // A missing decoder is a wiring bug, not a runtime branch. Fail
        // fast so the outbox row stays claimed (lease will expire) rather
        // than silently delivering an unbranded payload.
        throw new SystemError(
          SystemErrorCode.InternalServerError,
          `No decoder registered for event type "${type}"`,
        );
      }
      return decoder(type, payload, meta);
    },
  };
}
