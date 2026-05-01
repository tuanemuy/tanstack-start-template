/**
 * Domain event base shared across all domains. Events are immutable records
 * collected via {@link WithEvents} on entity-producing operations and
 * published through the Outbox pattern.
 */

export type DomainEventBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  id: string;
  type: TType;
  payload: TPayload;
  occurredAt: Date;
  /** Id of the aggregate that emitted the event. */
  aggregateId: string;
}>;

export type DomainEvent = DomainEventBase;

/**
 * Decode a wire-format event row back into a typed domain event. Each
 * decoder re-runs the payload through value-object factories so consumers
 * receive branded types, and throws on a malformed row — the relay worker
 * catches per-row to skip + log without aborting the batch.
 */
export type EventDecoder<TEvent extends DomainEvent = DomainEvent> = (
  type: string,
  payload: Record<string, unknown>,
  meta: Readonly<{ id: string; occurredAt: Date; aggregateId: string }>,
) => TEvent;

/**
 * Wrapper for an entity-producing operation that also emits domain events.
 * Callers must explicitly route the events through `collectEvents` inside a
 * unit of work.
 */
export type WithEvents<
  TEntity,
  TEvent extends DomainEvent = DomainEvent,
> = Readonly<{
  entity: TEntity;
  events: readonly TEvent[];
}>;
