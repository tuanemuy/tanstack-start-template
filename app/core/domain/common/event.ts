/**
 * Domain Event - base definitions shared across all domains.
 *
 * Events are immutable records describing something that happened in the
 * domain. They are collected by aggregates (via `WithEvents`) and published
 * through the Outbox pattern so that cross-aggregate effects can be handled
 * reliably.
 */

export type DomainEventBase<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<{
  id: string;
  type: TType;
  payload: TPayload;
  occurredAt: Date;
  aggregateId?: string;
}>;

export type DomainEvent = DomainEventBase;

/**
 * Wrapper for an entity-producing operation that also emits domain events.
 *
 * Domain factory/behavior methods return `WithEvents<Entity, Event>` rather
 * than bare entities so that callers must explicitly deal with emitted events
 * (typically by handing them to `collectEvent` inside a unit of work).
 *
 * `TEntity` may be instantiated as `null` to represent aggregate deletion:
 * the operation removes the aggregate entirely, so there is no successor
 * entity, but the emitted events (e.g. `todo.deleted`) must still flow
 * through the outbox.
 */
export type WithEvents<
  TEntity,
  TEvent extends DomainEvent = DomainEvent,
> = Readonly<{
  entity: TEntity;
  events: readonly TEvent[];
}>;
