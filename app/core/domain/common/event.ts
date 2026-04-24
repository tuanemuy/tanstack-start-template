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
  /**
   * The id of the aggregate that emitted this event. Required for every event
   * in the system: relay workers and downstream consumers rely on it for
   * routing/filtering, and requiring it up front prevents callers from
   * shipping "contextless" events that cannot be traced back to an origin.
   */
  aggregateId: string;
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
  aggregateId: string;
  schemaVersion: number;
}>;

/**
 * Result of a decode attempt.
 *
 * Decoders return a discriminated union rather than throwing so that a single
 * corrupt outbox row cannot halt a whole relay batch. Callers (the event
 * relay worker in particular) branch on `ok` and route decode failures to
 * their own observability path (skip + alert) without propagating an
 * exception that would unwind the batch loop.
 */
export type EventDecodeResult<TEvent extends DomainEvent = DomainEvent> =
  | Readonly<{ ok: true; event: TEvent }>
  | Readonly<{ ok: false; error: Error }>;

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
) => EventDecodeResult<TEvent>;

/**
 * Wrapper for an entity-producing operation that also emits domain events.
 *
 * Domain factory/behavior methods return `WithEvents<Entity, Event>` rather
 * than bare entities so that callers must explicitly deal with emitted events
 * (typically by handing them to `collectEvents` inside a unit of work).
 *
 * ## Usage with deletion (`TEntity = null`)
 *
 * Aggregate deletion is modelled as `WithEvents<null, TEvent>` — the
 * operation removes the aggregate entirely, so there is no successor
 * entity, but the emitted event (e.g. `todo.deleted`) must still flow
 * through the outbox. Callers destructure exactly like a non-terminal
 * operation and route events through `collectEvents`:
 *
 * ```ts
 * const now = container.clock.now();
 * const { events } = Todo.delete(todo, now);
 * await todoRepository.delete(todo.id, todo.version);
 * collectEvents(events);
 * ```
 *
 * The `null` entity is deliberately not optional: keeping the field present
 * keeps the result shape uniform across successor-producing and terminal
 * operations, and prevents `WithEvents<null>` from being accidentally
 * widened to `WithEvents<Something | undefined>`.
 */
export type WithEvents<
  TEntity,
  TEvent extends DomainEvent = DomainEvent,
> = Readonly<{
  entity: TEntity;
  events: readonly TEvent[];
}>;
