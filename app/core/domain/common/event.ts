/**
 * Domain Event - base definitions shared across all domains.
 *
 * Events are immutable records describing something that happened in the
 * domain. They are collected by aggregates (via {@link WithEvents}) and
 * published through the Outbox pattern so that cross-aggregate effects can
 * be handled reliably.
 */

export type DomainEventBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  id: string;
  type: TType;
  payload: TPayload;
  occurredAt: Date;
  /**
   * Id of the aggregate that emitted the event. Required so relay workers and
   * downstream consumers can route / filter by origin without parsing payload.
   */
  aggregateId: string;
}>;

export type DomainEvent = DomainEventBase;

/**
 * Decode a wire-format event row back into a typed domain event.
 *
 * Each domain owns one decoder that re-runs the payload through its
 * value-object factories so consumers receive branded types. The decoder
 * throws on a malformed row — the event relay worker catches per-row to
 * skip + log without aborting the batch.
 */
export type EventDecoder<TEvent extends DomainEvent = DomainEvent> = (
  type: string,
  payload: Record<string, unknown>,
  meta: Readonly<{ id: string; occurredAt: Date; aggregateId: string }>,
) => TEvent;

/**
 * Wrapper for an entity-producing operation that also emits domain events.
 *
 * Domain factory/behavior methods return `WithEvents<Entity, Event>` rather
 * than bare entities so callers must explicitly route emitted events through
 * `collectEvents` inside a unit of work.
 *
 * Aggregate deletion is modelled as `WithEvents<null, TEvent>` — `entity: null`
 * marks the aggregate as gone while keeping the result shape uniform.
 */
export type WithEvents<
  TEntity,
  TEvent extends DomainEvent = DomainEvent,
> = Readonly<{
  entity: TEntity;
  events: readonly TEvent[];
}>;
