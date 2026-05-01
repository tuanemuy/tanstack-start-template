export type DomainEventBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  id: string;
  type: TType;
  payload: TPayload;
  occurredAt: Date;
  aggregateId: string;
}>;

export type DomainEvent = DomainEventBase;

export type EventDecoder<TEvent extends DomainEvent = DomainEvent> = (
  type: string,
  payload: Record<string, unknown>,
  meta: Readonly<{ id: string; occurredAt: Date; aggregateId: string }>,
) => TEvent;

export type WithEvents<
  TEntity,
  TEvent extends DomainEvent = DomainEvent,
> = Readonly<{
  entity: TEntity;
  events: readonly TEvent[];
}>;
