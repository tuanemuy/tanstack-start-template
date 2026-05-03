import { BusinessRuleError } from "@/core/domain/error";

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

export type DomainEventBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  id: EventId;
  type: TType;
  payload: TPayload;
  occurredAt: Date;
  aggregateId: string;
}>;

export type DomainEvent = DomainEventBase;

export type EventDecoder<TEvent extends DomainEvent = DomainEvent> = (
  type: string,
  payload: Record<string, unknown>,
  meta: Readonly<{ id: EventId; occurredAt: Date; aggregateId: string }>,
) => TEvent;

export type WithEvents<
  TEntity,
  TEvent extends DomainEvent = DomainEvent,
> = Readonly<{
  entity: TEntity;
  events: readonly TEvent[];
}>;
