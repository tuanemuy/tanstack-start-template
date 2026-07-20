import { BusinessRuleError } from "@repo/core/domain/error";

declare const eventIdBrand: unique symbol;

export type EventId = string & { readonly [eventIdBrand]: true };

// As with `TodoId`, the domain treats event ids as opaque, non-empty
// strings. Format (UUIDv7 in this template) is the `IdGenerator`'s
// responsibility, validated on rehydration by storage adapters.
export const EventId = {
  create: (id: string): EventId => {
    if (id.trim().length === 0) {
      throw new BusinessRuleError("INVALID_EVENT_ID", "Invalid event id");
    }
    return id as EventId;
  },
};

// `DomainEventDraftBase` is the identity-less shape produced by the domain.
// `EventId` is an application-level concern (it requires `IdGenerator`), so
// the domain emits drafts and the application attaches `id` before they are
// persisted to the outbox.
export type DomainEventDraftBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  type: TType;
  payload: TPayload;
  occurredAt: Date;
  aggregateId: string;
}>;

export type DomainEventBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = DomainEventDraftBase<TType, TPayload> & Readonly<{ id: EventId }>;

export type DomainEvent = DomainEventBase;

// Identity-less event shape returned by domain functions. Application
// usecases lift drafts into `DomainEvent` via `attachEventIds`.
//
// The conditional is what makes this **distributive** over event unions:
// `EventDraft<TodoCreatedEvent | TodoToggledEvent>` expands to
// `Omit<TodoCreatedEvent, "id"> | Omit<TodoToggledEvent, "id">` rather than
// collapsing to a single shape — which is what preserves the `type`
// discriminator and lets consumers narrow on `draft.type`.
export type EventDraft<TEvent extends DomainEvent = DomainEvent> =
  TEvent extends unknown ? Omit<TEvent, "id"> : never;

// Decoders are looked up by `event.type` in the registry, so the type is
// already known by construction at the call site — passing it again would
// be redundant. The `type` literal lives inside `TEvent["type"]` and is
// re-attached by the decoder body.
//
// `payload` is `unknown`: it comes from the at-rest outbox row and has not
// been shape-checked yet. The decoder body is the one that runs zod
// validation and throws on mismatch.
export type EventDecoder<TEvent extends DomainEvent = DomainEvent> = (
  payload: unknown,
  meta: Readonly<{ id: EventId; occurredAt: Date; aggregateId: string }>,
) => TEvent;

export type WithEventDrafts<
  TEntity,
  TEvent extends DomainEvent = DomainEvent,
> = Readonly<{
  entity: TEntity;
  eventDrafts: readonly EventDraft<TEvent>[];
}>;

// `Omit<TEvent, "id"> & { id: EventId }` is structurally `TEvent`, but TS
// cannot prove that for arbitrary distributive `TEvent`. The unsafe cast is
// centralised here so the assumption lives in exactly one place — callers
// see a fully typed `TEvent[]`.
export function attachEventIds<TEvent extends DomainEvent>(
  drafts: readonly EventDraft<TEvent>[],
  mintId: () => EventId,
): readonly TEvent[] {
  return drafts.map((draft) => ({ ...draft, id: mintId() }) as TEvent);
}
