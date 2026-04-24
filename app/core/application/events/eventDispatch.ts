import type {
  DomainEvent,
  EventDecodeMeta,
  EventDecodeResult,
  EventDecoder,
} from "@/core/domain/common/event";
import { SystemError, SystemErrorCode } from "../errors";

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
 * reported via the Result channel rather than passed through raw, because
 * a silent passthrough would let a typo'd event type reach dispatchers
 * that expect branded payloads.
 *
 * `decode` returns the same {@link EventDecodeResult} shape as a domain
 * decoder so callers can branch on `ok` uniformly regardless of whether
 * the failure originated in the registry ("unknown prefix") or in the
 * domain ("malformed payload").
 */
export type EventDecoderRegistry = Readonly<{
  decode: (entry: EventDecodeInput) => EventDecodeResult<DomainEvent>;
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
        // A missing decoder is a wiring bug, not a recoverable runtime
        // condition. Report it through the Result channel so the worker
        // can surface it (skip + alert) without an exception unwinding
        // the whole batch.
        return {
          ok: false,
          error: new SystemError(
            SystemErrorCode.InternalServerError,
            `No decoder registered for event type "${type}"`,
          ),
        };
      }
      return decoder(type, payload, meta);
    },
  };
}
