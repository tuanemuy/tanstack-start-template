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
  /**
   * On-the-wire schema version for {@link payload}. Each domain's event
   * factory stamps its own `*_EVENT_SCHEMA_VERSION` constant so that the
   * outbox adapter stays domain-agnostic: it reads `event.schemaVersion`
   * verbatim rather than mapping `type` back to a domain.
   *
   * Bump the domain's constant (and branch inside its `decode*Event`) when
   * the payload shape changes in a consumer-visible way.
   */
  schemaVersion: number;
  aggregateId?: string;
}>;

export type DomainEvent = DomainEventBase;

/**
 * Metadata a transport (typically the outbox) hands to a domain decoder so
 * it can reconstruct a branded event from its wire payload. Duplicates the
 * fields that live in dedicated columns (`id`, `occurred_at`,
 * `schema_version`, `aggregate_id`) so decoders never have to parse JSON
 * to reach them.
 */
export type EventDecodeMeta = Readonly<{
  id: string;
  occurredAt: Date;
  aggregateId?: string;
  schemaVersion: number;
}>;

/**
 * Reconstruct a typed domain event from its wire representation. Each
 * domain owns exactly one decoder that re-runs the payload through its
 * value-object factories so consumers receive branded types rather than
 * free-form strings.
 */
export type EventDecoder<TEvent extends DomainEvent = DomainEvent> = (
  type: string,
  payload: Record<string, unknown>,
  meta: EventDecodeMeta,
) => TEvent;

/**
 * Wrapper for an entity-producing operation that also emits domain events.
 *
 * Domain factory/behavior methods return `WithEvents<Entity, Event>` rather
 * than bare entities so that callers must explicitly deal with emitted events
 * (typically by handing them to `collectEvents` inside a unit of work).
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
