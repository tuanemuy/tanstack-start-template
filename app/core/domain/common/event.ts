import { BusinessRuleError } from "@/core/domain/error";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare const eventIdBrand: unique symbol;

export type EventId = string & { readonly [eventIdBrand]: true };

export const EventId = {
  create: (id: string): EventId => {
    if (!UUID_V7_PATTERN.test(id)) {
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
