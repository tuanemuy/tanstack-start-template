# Backend Implementation Guide

The Todo domain implementation is the canonical example. When adding a new domain, just follow the same structure.

> For principles and abstract concepts, see `CLAUDE.md`. This document is a collection of copy-and-adapt patterns for "how to actually write the code".

## File Layout

```
packages/core/src/
├── domain/
│   ├── common/
│   │   ├── event.ts               DomainEventBase, EventDraft, EventDecoder, WithEventDrafts
│   │   └── pagination.ts
│   ├── error.ts                   BusinessRuleError
│   └── ${domain}/
│       ├── entity.ts
│       ├── valueObject.ts
│       ├── events.ts
│       ├── errorCode.ts
│       └── ports/${domain}Repository.ts
├── application/
│   ├── di/types.ts                SharedDeps, RequestContainer, WorkerContainer, AppConfig
│   ├── di/containerStore.ts       ContainerStore, installContainerStore, getInstalledStore, getContainer (shared)
│   ├── di/serverCloudflare.ts     createRequestContainer, createWorkerContainer, readRequestServerConfig (CF runtime)
│   ├── di/serverNode.ts           createNodeRequestContainer, createNodeWorkerContainer, readNodeServerEnv (Node runtime)
│   ├── ports/
│   │   ├── clock.ts
│   │   ├── idGenerator.ts
│   │   ├── logger.ts
│   │   └── outboxRepository.ts
│   ├── errors/index.ts            NotFound / Conflict / Validation / SystemError + helpers
│   ├── events/
│   │   └── buildDecoder.ts
│   ├── execution/unitOfWork.ts    UnitOfWorkContext enumerates repository slots directly
│   ├── workers/
│   │   ├── eventRelayWorker.ts
│   │   └── outboxPrune.ts
│   ├── types.ts                   ServiceArgs<T>
│   └── ${domain}/
│       ├── view.ts
│       ├── eventDecoders.ts       outbox row → DomainEvent rehydration (lives in application because it depends on SystemError)
│       ├── ${usecase}.ts
│       └── __tests__/
├── presentation/
│   ├── errorResponse.ts             AppServerError, serializeError, extractSerializedError, httpStatusFor
│   ├── errorResponseMiddleware.ts   errorResponseMiddleware (wraps inputValidator + handler)
│   ├── errorDisplay.ts            displayError, sanitizeRouteError
│   └── validator.ts               validateInput(schema) — transport-boundary shape check
└── adapters/
    └── d1/
        ├── client.ts
        ├── schema.ts              domain tables + `_occ_guard` (for OCC abort in the deferred-batch UoW)
        ├── unitOfWork.ts          D1UnitOfWorkProvider that assembles a PendingBatch and flushes via db.batch()
        ├── pendingBatch.ts        Drizzle BatchItem buffer + automatic OCC guard injection
        ├── repositories/
        │   ├── helpers.ts         mapDbError + isOccGuardViolation
        │   ├── ${domain}Repository.ts
        │   └── outboxRepository.ts
        └── migrations/            SQL migrations read by wrangler

packages/core/src/lib/
└── error.ts                       CodedError base + SerializedErrorBase / FieldErrors / SerializableError interface (structure only; the union is assembled in presentation)
```

## Domain Layer

### Value Object

```ts
declare const fooIdBrand: unique symbol;
export type FooId = string & { readonly [fooIdBrand]: true };

export const FooId = {
  create: (id: string): FooId => {
    if (id.trim().length === 0) {
      throw new BusinessRuleError(FooErrorCode.InvalidId, "Invalid foo id");
    }
    return id as FooId;
  },
};
```

Key points:

- `unique symbol` for nominal typing
- the factory is the only creation path
- invalid values throw `BusinessRuleError` (the Result type is not used)
- **do not add `generate()`**. id generation goes through the `IdGenerator` port in the application layer
- domain treats the id as an "opaque non-empty string". The format (UUIDv7 / ULID / KSUID, etc.) is the responsibility of the `IdGenerator` implementation, and the storage adapter re-validates it with `IdGenerator.validate(id)` at rehydration time. Putting generation and validation behind the same port means that when you swap the generator, the validator switches over in pair automatically, letting you swap the format without touching the VO

### Entity

```ts
export type ActiveFoo = FooBase & Readonly<{ status: "active" }>;
export type CompletedFoo = FooBase & Readonly<{ status: "completed" }>;
export type Foo = ActiveFoo | CompletedFoo;

export const Foo = {
  create: (
    params: { id: string; /* ...domain inputs... */ },
    now: Date,
  ): WithEventDrafts<ActiveFoo, FooEvent> => {
    const id = FooId.create(params.id);
    const foo: ActiveFoo = { ...params, id, version: 0, createdAt: now, updatedAt: now };
    return { entity: foo, eventDrafts: [FooEvents.created(foo.id, now)] };
  },

  complete: (
    foo: ActiveFoo,
    now: Date,
  ): WithEventDrafts<CompletedFoo, FooEvent> => {
    const next: CompletedFoo = { ...foo, status: "completed", version: foo.version + 1, updatedAt: now };
    return { entity: next, eventDrafts: [FooEvents.completed(next.id, now)] };
  },
};
```

Key points:

- represent state with a discriminated union → invalid transitions become type errors
- as with `Todo.create`, **VO construction is concentrated in the entity factory** (the application layer passes `id` as a raw string)
- take `now: Date` and the required `id` as arguments (domain never calls `new Date()` or `uuidv7()`)
- state transitions return `WithEventDrafts<TEntity, TEvent>`, handling the entity together with its **identity-less drafts**. Assigning the `EventId` is the application layer's responsibility (`attachEventIds`)
- for operations with no successor entity, such as deletion, do not put a method on the domain; the usecase emits `FooEvents.deleted(...)` directly

### Domain Event

```ts
export type FooCreatedEvent = DomainEventBase<
  "foo.created",
  Readonly<{ fooId: FooId }>
>;

export type FooEvent = FooCreatedEvent | FooDeletedEvent;

export const FooEvents = {
  created: (fooId: FooId, occurredAt: Date): EventDraft<FooCreatedEvent> => ({
    type: "foo.created",
    payload: { fooId },
    occurredAt,
    aggregateId: fooId,
  }),

  deleted: (fooId: FooId, occurredAt: Date): EventDraft<FooDeletedEvent> => ({
    type: "foo.deleted",
    payload: { fooId },
    occurredAt,
    aggregateId: fooId,
  }),
};
```

Key points:

- the factory returns **identity-less drafts**. The `EventId` is minted **inside the UoW** via `idGenerator` (the usecase just calls `collectEvents(drafts)`)
- this removes `EventId` from domain-function arguments and concentrates the id-generation responsibility in the single UoW adapter
- domain holds only event types and factories; the decoder goes to the application layer (keeping the dependency direction inward)

#### Event Decoder (application layer)

Write the decoder declaratively with the `buildEventDecoder(type, schema, rehydrate)` helper. You only write the schema definition + brand reconstruction; the helper absorbs the shape assert / `SystemError` conversion / meta forwarding.

```ts
// packages/core/src/application/foo/eventDecoders.ts
import { z } from "zod";
import type { EventDecoder } from "@repo/core/domain/common/event";
import type { FooEvent } from "@repo/core/domain/foo/events";
import { FooId } from "@repo/core/domain/foo/valueObject";
import { buildEventDecoder } from "../events/buildDecoder";

const fooCreatedSchema = z.object({ fooId: z.string() }).strict();
const fooDeletedSchema = z.object({ fooId: z.string() }).strict();

export type FooEventDecoders = {
  readonly [K in FooEvent["type"]]: EventDecoder<
    Extract<FooEvent, { type: K }>
  >;
};

export const fooEventDecoders: FooEventDecoders = {
  "foo.created": buildEventDecoder("foo.created", fooCreatedSchema, (p) => ({
    fooId: FooId.create(p.fooId),
  })),
  "foo.deleted": buildEventDecoder("foo.deleted", fooDeletedSchema, (p) => ({
    fooId: FooId.create(p.fooId),
  })),
};
```

Key points:

- put the decoder in the **application layer**. Since it maps decode failures to `SystemError(DataIntegrityError)`, it depends on the application's error contract and therefore cannot live in the inward-facing domain
- when adding a domain, the only diff is "schema definition + brand reconstruction". The shape assert / error conversion logic is confined to `buildEventDecoder`
- the payload schema rejects extra fields with `z.object(...).strict()`
- the whole map is typed as `[K in FooEvent["type"]]: EventDecoder<Extract<...>>` to enforce exhaustiveness (a missing registration in the map is a type error)
- branded types are reconstructed inside the `rehydrate` function via `FooId.create(p.fooId)`
- on decode failure, throw `SystemError(DataIntegrityError)` (the relay worker catches it per-row and routes it to the log)

### Repository Port

The base contract including OCC is already consolidated in `TransactionalRepository<TEntity, TId>` (`packages/core/src/domain/common/transactionalRepository.ts`). Each aggregate's port extends it and only adds read-only queries:

```ts
export interface FooRepository extends TransactionalRepository<Foo, FooId> {
  findPage(pagination: Pagination): Promise<PaginationResult<Foo>>;
}
```

What `TransactionalRepository<TEntity>` provides:

```ts
interface TransactionalRepository<TEntity, TId = string> {
  insert(entity: TEntity): Promise<void>;
  findById(id: TId): Promise<Versioned<TEntity> | null>;
  save(entity: TEntity, expectedVersion: ExpectedVersion<TEntity>): Promise<void>;
  delete(id: TId, expectedVersion: ExpectedVersion<TEntity>): Promise<void>;
}

type Versioned<T> = { readonly entity: T; readonly expectedVersion: ExpectedVersion<T> };
type ExpectedVersion<T> = number & { readonly [brand]: T };  // phantom T
```

Bind `TId` to the branded `FooId`, not the raw `string` default. The lookup key is then a value object: the usecase constructs it via `FooId.create(input.id)` at its boundary — before the lookup — so the id-format invariant is checked in one place and is no longer duplicated against the transport-layer schema. This is the same "validate at value-object construction" rule the entity factory already follows; an id and an entity are separate concerns, so the id VO is built up front while the entity is what `findById` returns once existence is confirmed. Binding `TId` also makes a foreign id (a `BarId` passed to a `Foo` repository) a type error.

OCC is enforced at the type level with the `ExpectedVersion<Foo>` token:

- only `findById` is the legitimate token-issuing point (a single `as` cast inside the adapter)
- `save` / `delete` take the token as a required argument → "writing without reading" is a type error
- `insert` is exclusively for initial persistence. Since no version exists yet, no OCC token is needed
- read-only queries like `findPage` are defined separately on the concrete port

Thanks to the phantom `T`, `ExpectedVersion<Foo>` and `ExpectedVersion<Bar>` are type-incompatible → **mixing up tokens between aggregates is a type error**. This severs the implicit connection of "the domain function bumps the version → the adapter recomputes `entity.version - 1`", giving a contract where the version observed at read time is carried straight through to the write.

When adding a new domain:

1. add one slot line to `UnitOfWorkContext` (`packages/core/src/application/execution/unitOfWork.ts`)
2. in the D1 adapter (`packages/core/src/adapters/d1/unitOfWork.ts`), create the repository instance sharing the `PendingBatch` and stuff it into the context

```ts
export interface UnitOfWorkContext {
  todoRepository: TodoRepository;
  fooRepository: FooRepository;          // ← added
  collectEvents(events: readonly DomainEvent[]): void;
}
```

## Application Layer

### Usecase

```ts
export async function createFoo({
  container,
  input,
}: ServiceArgs<CreateFooInput>): Promise<CreateFooOutput> {
  const now = container.clock.now();
  const id = container.idGenerator.next();

  const { entity: foo, eventDrafts } = Foo.create(
    { id, /* ...input fields... */ },
    now,
  );

  await container.unitOfWorkProvider.run(
    async ({ fooRepository, collectEvents }) => {
      await fooRepository.insert(foo);
      collectEvents(eventDrafts);
    },
  );

  return { foo: toFooView(foo) };
}
```

```ts
// for operations with "no successor entity", such as deletion, the usecase emits the event directly
export async function deleteFoo({
  container,
  input,
}: ServiceArgs<DeleteFooInput>): Promise<void> {
  const now = container.clock.now();
  const id = FooId.create(input.id);

  await container.unitOfWorkProvider.run(
    async ({ fooRepository, collectEvents }) => {
      const found = await fooRepository.findById(id);
      if (!found) throw new NotFoundError("FOO_NOT_FOUND", `...`);
      await fooRepository.delete(found.entity.id, found.expectedVersion);
      collectEvents([FooEvents.deleted(found.entity.id, now)]);
    },
  );
}
```

Key points:

- resolve `now` / `id` at the top of the usecase. The `EventId` is minted **by the UoW inside `collectEvents`** via `idGenerator`, so the usecase doesn't have to care
- there are 4 VO-construction sites: the entity factory, the lookup-key construction at the top of a mutate/delete usecase (`FooId.create(input.id)`), adapter rehydration, and the event decoder
- domain functions return identity-less drafts, and you just pass them straight through with `collectEvents(drafts)`. No explicit type arguments needed
- ride the Outbox pattern with `collectEvents` (flushed in the same tx)
- the return value is a DTO (projected by a helper in `view.ts`). Type its fields as primitives, never branded VOs — brands widen to their primitive for free, so projection stays cast-free; the inbound direction is the VO `create()` above, also not a cast

There is intentionally no generic utility for OCC retry. `ConflictError` propagates straight to the caller, and only the usecases that need it build their own retry individually.

### Container Wiring

Provide the container as **two independent types, one per scope**. Mix in `SharedDeps` (`clock` / `idGenerator` / `logger` / `shutdown`) by intersection, and have each scope hold only the fields that are needed in that scope alone.

```ts
export type SharedDeps = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
  shutdown: () => Promise<void>;
}>;

// For usecases that mutate aggregates / SSR head. It does not hold `outboxRepository`
// (writes happen from inside the UoW via `collectEvents`), nor `idempotencyStore`
// (queue-consumer only).
export type RequestContainer = SharedDeps &
  Readonly<{ config: AppConfig; unitOfWorkProvider: UnitOfWorkProvider }>;

// For relay / pruner / queue consumer / DLQ that read and write the outbox directly.
// It does not hold `config` or `unitOfWorkProvider`.
export type WorkerContainer = SharedDeps &
  Readonly<{
    outboxRepository: OutboxRepository;
    idempotencyStore: IdempotencyStore;
  }>;
```

```ts
export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer { /* ...UoW + AppConfig... */ }

export function createWorkerContainer(env: ServerEnv): WorkerContainer {
  /* ...outboxRepository + idempotencyStore... */
}
```

Pass `idGenerator` to the `UnitOfWorkProvider`. It uses this to mint the `EventId` when `collectEvents` flushes drafts to the outbox. If you pass the same instance as the container's own `idGenerator`, swapping in a Fake for tests is a single-point change.

Consolidate the path that reads request-side env into `readRequestServerConfig()`. A worker just passes `env: ServerEnv` straight to `createWorkerContainer`, without going through `AppConfig` or the `relay` Service Binding (because a worker neither returns HTML nor kicks the relay).

The test-only `TestContainer = RequestContainer & WorkerContainer & { db }` flattens the fields of both scopes into a single fat shape — a convenience type for co-locating usecase invocation and worker-pipeline verification within a test. Production code never holds this intersection directly; it always receives either `RequestContainer` or `WorkerContainer`.

Transient lock contention such as `SQLITE_BUSY` is retried internally by `DrizzleSqliteUnitOfWorkProvider` (a driver-level concern, so the application layer doesn't touch it).

## Adapter Layer

### Repository (OCC implementation)

```ts
async save(foo: Foo): Promise<void> {
  if (foo.version === 0) {
    await this.executor.insert(foos).values({ ...foo });
    return;
  }
  const updated = await this.executor
    .update(foos)
    .set({ ...foo })
    .where(and(eq(foos.id, foo.id), eq(foos.version, foo.version - 1)))
    .returning({ id: foos.id });
  if (updated.length === 0) {
    throw new ConflictError(
      "OPTIMISTIC_LOCK_FAILURE",
      `Optimistic lock failure: ${foo.id}`,
    );
  }
}
```

Key points:

- a 0-row update → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
- DB exceptions are converted to `SystemError(DatabaseError)` by `mapDbError`
- do not use upsert (`ON CONFLICT DO UPDATE`) (because it would hide lost updates)

### Unit of Work

`packages/core/src/adapters/d1/unitOfWork.ts` implements `UnitOfWorkProvider.run(fn)`:

1. create a fresh `PendingBatch` (Drizzle BatchItem buffer)
2. build the repository / outbox instances together with the shared PendingBatch and stuff them into `UnitOfWorkContext`
3. pass `fn` a context that gathers the `collectEvents` buffer
4. after `fn` resolves, stack the collected events onto the same PendingBatch
5. flush atomically with `db.batch(pending.build())`

Because D1 has no interactive tx, writes are not executed one-by-one inside the UoW but accumulated in the PendingBatch. Reads are immediate, hitting the binding directly. An OCC mismatch aborts the entire batch via the CHECK constraint on the `_occ_guard` table and reaches the presentation layer as `ConflictError("OPTIMISTIC_LOCK_FAILURE")`.

There is no application-level retry because driver-level transient errors are handled on the Cloudflare binding side.

## Outbox Worker

```ts
import { processOutboxEvents } from "@repo/core/application/workers/eventRelayWorker";

await processOutboxEvents(container, async (event) => {
  // switch on event.type and dispatch to the downstream handler
}, { batchSize: 100 });
```

### Delivery contract (pitfalls the consumer implementation must guard against)

As stated in the CLAUDE.md key concepts, the Outbox operates with **at-least-once delivery / no ordering**. Write the consumer on that premise. The "why" of the principle is in CLAUDE.md; here we expand on "what the implementation must guard against".

- **At-least-once (the same event arrives two or more times)** — the relay worker operates in the order "dispatch succeeds → update the outbox row's `processed_at`". If dispatch goes through but the process dies just before the update, the same event is re-dispatched in the next round. Write the consumer so that **processing the same event N times produces the same result**, either via `event.id`-based dedupe (a processed-id table / unique index) or a natural-key upsert. Code that assumes "trigger a side effect exactly once" (the "fire-and-forget" of external sends, billing, notifications) will duplicate the moment at-most-once breaks.
  - The `IdempotencyStore` port bundled with the template (the `processed_events` table + D1 `INSERT OR IGNORE` to claim) is the minimal implementation of a "processed-id table". `handleQueue` calls `markProcessed(event.id)` before running the handler, and if `alreadyProcessed: true` it skips the handler and acks. Follow the same pattern when writing new consumers.
  - **Stamp first vs stamp inside handler** — the template default is stamp first (claim → handler → ack). This order is safe if you write the handler as an idempotent overwrite (a projection UPSERT, etc.) whose result is unchanged on re-run. Conversely, when you want to **roll back the side effect and the stamp together** (the one-shot kind of external send, billing, notification), wrap the handler in `UnitOfWorkProvider.run` and put `markProcessed` and the side-effect write in the same batch within that UoW.
- **No ordering (zero ordering guarantee)** — each row is rescheduled individually based on its `next_attempt_at` (spread out by backoff + jitter) and `attempts`, so an ordering where `foo.updated` / `foo.deleted` arrives before `foo.created` happens routinely. Don't write consumer-side logic that assumes a state transition like "if I see `deleted`, I must have seen `created`". If you need order, either **read the aggregate's current state before deciding**, or make the event self-contained by putting all the required state into the event payload.
- **Quarantine (isolating poison rows)** — a row whose `attempts` reaches `maxAttempts` (default 2) gets `failed_at` set and is quarantined. A partial index drops it from `claimPending`, so a poison row doesn't block the hot path. To re-kick, reset `failed_at` / `next_attempt_at` to NULL and reset `attempts` to 0. Decode failures (payload schema mismatch) ride the same retry path — after fixing the schema, re-kick and it is re-dispatched. The relay's `maxAttempts` × the consumer's `1 + max_retries` (`wrangler.consumer.toml`) = the total number of attempts visible to the user. The rule of thumb is to keep this as a product of small values; setting one side to 5 inflates to 25 attempts even if the other is only 5.
- **Multi-worker safety (claim/lease)** — a row is locked within a single claim+select transaction and becomes invisible to other workers for the lease period. On worker crash, the row is re-claimable once the lease expires. Even with multiple workers running, the same row is not dispatched twice.

### Key points

- log decode / dispatch failures to the logger and reschedule `next_attempt_at` with `attempts++` + exponential backoff

After adding a new domain, export `<domain>EventDecoders` from `packages/core/src/application/${domain}/eventDecoders.ts` and add it to both the `AllDomainEvents` type union and `defaultEventDecoderRegistry` in `eventRelayWorker.ts`:

```ts
type AllDomainEvents = TodoEvent | FooEvent;        // ← extend the union

export const defaultEventDecoderRegistry = {
  ...todoEventDecoders,
  ...fooEventDecoders,        // ← add the decoder
} satisfies DefaultEventDecoderRegistry;
```

`DefaultEventDecoderRegistry` is a complete map type derived from `AllDomainEvents`, and `satisfies` rejects, as a compile error, the case where you wrote only the decoder while forgetting to add the domain — and vice versa. `EventDecoderRegistry` (`Partial<DefaultEventDecoderRegistry>`) is the type for passing overrides in tests and the like, forbidding unknown event types at the syntax level.

### Outbox Prune

```ts
import { pruneOutbox } from "@repo/core/application/workers/outboxPrune";

await pruneOutbox(container, { retentionMs: 7 * 86_400_000 }); // retain for 7 days
```

`retentionMs` is raw milliseconds. `pruneOutbox` uses `clock.now() - retentionMs` as the cutoff and calls `outboxRepository.pruneProcessed(cutoff)`. It does not touch pending rows (`processed_at IS NULL`). It is safe to run concurrently with the relay worker.

## Error Design

| Layer | Error type | Location |
|---|---|---|
| Domain | `BusinessRuleError<FooErrorCode>` | `packages/core/src/domain/error.ts` |
| Application | `NotFoundError`, `ConflictError`, `ValidationError`, `SystemError` | `packages/core/src/application/errors.ts` |
| Presentation | `AppServerError` | `apps/web/app/presentation/errorResponse.ts` |

Every error class extends the abstract base `CodedError<TCode extends string>` in `packages/core/src/lib/error.ts`. The base class owns the `code: TCode` field, a default `retryable: false` getter, and the abstract method `toSerialized()`. The base's return type is the structural `SerializedErrorBase & { kind: string }`, and each subclass narrows it via override to its own `kind`-tagged variant.

`code` is a plain string. The per-class enums are deliberately collapsed (the domain enum plus the `SerializedErrorKind` assembled in presentation cover the classification we need). `SystemErrorCode` is kept because it is used for the runtime `retryable` decision.

`BusinessRuleError<TCode extends string = never>` defaults to `never`. Allowing an unparameterized `BusinessRuleError` would widen `code` to `string` at catch time, so we force the throw side to pass the domain's literal union. `isBusinessRuleError(...)` narrows to `BusinessRuleError<string>`.

Each error class declares its own `Serialized*Error` variant in the same file (`SerializedBusinessError` in domain, `SerializedNotFoundError` etc. in application) and returns that variant from `toSerialized()`. The presentation layer's `errorResponse.ts` gathers all variants and assembles the `SerializedError` discriminated union. Adding a new error type does not require touching presentation's `serializeError` (it just calls `toSerialized()` structurally). Only the `SerializedError` union and `SerializedErrorKind` need to be appended in the presentation layer.
