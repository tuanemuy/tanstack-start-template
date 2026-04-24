# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Principles

- Prioritize type safety by leveraging TypeScript's type system to the fullest extent
- Prefer a stateless, pure functional programming style for the domain and application layers. Adapter classes are acceptable when they encapsulate a single external resource (DB connection, HTTP client) and keep all mutable state internal.
- Make illegal states unrepresentable at the type level before falling back to runtime checks.

## Development Commands

- `pnpm dev` - Start the Vite dev server (TanStack Start)
- `pnpm build` - Build for production (`vite build`)
- `pnpm start` - Run the production server (`node .output/server/index.mjs`)
- `pnpm lint` - Lint code with Biome
- `pnpm lint:fix` - Lint code with Biome and fix issues
- `pnpm format` - Format code with Biome
- `pnpm format:check` - Check code formatting with Biome
- `pnpm typecheck` - Type check code with `@typescript/native-preview` (tsgo)
- `pnpm test` - Run tests with Vitest (all tests)
- `pnpm test:unit` - Run only unit tests (excludes `*.integration.test.ts`)
- `pnpm test:integration` - Run only integration tests (real SQLite DB)
- `TEST_DOMAIN=${domain(lowercase)} pnpm test:domain` - Run application-layer tests for a specific domain
- `TEST_DOMAIN=${domain(lowercase)} pnpm test:domain-layer` - Run domain-layer tests for a specific domain

## Code Quality

- Run `pnpm typecheck`, `pnpm run lint:fix` and `pnpm run format` after making changes to ensure code quality and consistency.

## Tech Stack

- **Runtime**: Node.js 22.x
- **Frontend**: TanStack Start (React Server Components enabled), TanStack Router, Tailwind CSS
- **Database**: libSQL / SQLite with Drizzle ORM. The checked-in adapter is validated against local file SQLite with WAL; remote Turso deployments must re-validate transaction and claim semantics before relying on the same outbox worker assumptions.

## Core Architecture

Hexagonal architecture with domain-driven design principles:

- **Domain Layer** (`app/core/domain/`): Contains business logic, types, and port interfaces
    - `app/core/domain/${domain}/entity.ts`: Domain entities
    - `app/core/domain/${domain}/valueObject.ts`: Value objects
    - `app/core/domain/${domain}/ports/**.ts`: Port interfaces for external services (repositories, exteranl APIs, etc.)
    - `app/core/domain/${domain}/services/**.ts`: Domain services for complex business logic
    - `app/core/domain/common/ports/clock.ts`: `Clock` port (`now(): Date`) plus the `SystemClock` implementation. Domain entities and value objects MUST NOT call `new Date()` themselves — entity factories / behaviour methods take `now: Date` as a required argument so they stay pure and deterministic under test. The `Clock` port itself is consumed by the application layer (see below); the domain only ever sees the resolved `Date` value.
    - `app/core/domain/common/ports/logger.ts`: `Logger` port (`info` / `warn` / `error` with optional structured `meta`) plus the `ConsoleLogger` implementation. Used for cross-cutting observability signals from workers and similar boundaries; domain / usecase happy paths do not log.
- **Adapter Layer** (`app/core/adapters/`): Contains concrete implementations for external services
    - `app/core/adapters/${externalServiceProvider}/**.ts`: Adapters for external services like databases, APIs, etc.
- **Application Layer** (`app/core/application/`): Contains use cases and application services
    - `app/core/application/di/server.ts`: Dependency injection setup (server-only, process-wide singleton). Distributes `Clock` and `Logger` directly on the `Container` rather than threading them through every UoW context, since they are not transactional resources and have no per-callback lifecycle.
    - `app/core/application/${domain}/${usecase}.ts`: Application services that orchestrate domain logic. Each service is a function that takes a context object. Usecases call `container.clock.now()` once at the entry point and pass the resulting `Date` into every domain operation that needs a timestamp, so all state mutations within a single usecase agree on "the same instant" by construction.
    - `app/core/domain/error.ts`: Error types for business logic
    - `app/core/domain/${domain}/errorCode.ts`: Error codes for each domain
    - `app/core/application/error.ts`: Error types for application layer
    - `app/core/application/execution/retry.ts`: `retry(fn, options)` is a plain `Promise<T>` API on top of TypeScript's standard `throw` / `try / catch`. It re-runs `fn` while `shouldRetry(error)` accepts the thrown value (with exponential backoff between attempts), short-circuits and re-throws verbatim when `shouldRetry` rejects, and re-throws the last error verbatim when `maxAttempts` is exhausted. No custom Result wrapper, no error wrapping — error identity (typed subclass, `code`, `cause`) survives end-to-end. An optional `onRetry(attempt, error)` hook is exposed for observability or attempt-counting at the call site without leaking that bookkeeping into the return type. Callers that want to convert "retryable but exhausted" into a typed application error (e.g. `ConflictError`) wrap `retry` in `try / catch` and re-run the same `shouldRetry` predicate on the caught value.
    - `app/core/application/__tests__/helpers.ts`: Test helpers for application services
- **Presentation Layer** (`app/core/presentation/`): Framework-specific cross-cutting utilities
    - `app/core/presentation/errorResponse.ts`: Server function error transport (`AppServerError`, `withErrorResponse`, re-exports of `SerializedError` / `serializeError` / `extractSerializedError`). The wire-format types live in `app/lib/serializedError.ts`.
    - `app/core/presentation/errorDisplay.ts`: Localized error message helpers for UI (`displayError`, `sanitizeRouteError`)

### Unit of Work

- `app/core/application/unitOfWork.ts`: Defines the `UnitOfWorkProvider` port plus three context shapes — `ReadonlyContext`, `ReadWriteContext`, `WorkerContext`.
- The provider exposes three methods: `runReadonly(fn)`, `runReadWrite(fn)`, `runWorker(fn)`. There is no single `run({ mode })` entry point; each path hands out its own context shape so callers pick the right one at the call site.
- `ReadonlyContext` exposes the `*Reader` subset of every port; `save` / `delete` / `saveEvents` are not callable in the readonly path at the **type level** (no runtime traps).
- `ReadWriteContext` adds `collectEvents(events)` (array signature) for the Outbox pattern. Events handed over in the callback are persisted to the outbox in the same transaction. The adapter stamps a monotonic `outbox_events.sequence`, so relay claim order follows collection order even when multiple events share the same timestamp.
- `WorkerContext` is carried by a phantom `unique symbol` marker and exposes only `outboxRepository: OutboxWorkerRepository`. It is mutually non-assignable with the other two, so domain repositories cannot be added to a worker context by an accidental refactor.
- `Clock` and `Logger` are intentionally NOT carried on any UoW context — they are non-transactional capabilities with no per-callback lifecycle, so distributing them through `Container` keeps the unique-symbol non-assignability invariant intact (no shared field would let you assign one context to another).
- `app/core/application/execution/retryingUnitOfWork.ts`: `RetryingUnitOfWorkProvider` decorator that retries transient contention errors across all three methods. `retry()` re-throws the last error verbatim, so the decorator simply forwards the call and the bare `UnitOfWorkProvider` contract (`Promise<T>` plus thrown errors on failure) passes through unchanged. The adapter-specific `isRetryable` predicate is injected at wire time (`createContainer`).
- Adapters (e.g. `app/core/adapters/drizzleSqlite/unitOfWork.ts`) implement the bare port; retry is composed on top via the decorator.

### Domain Events

- `app/core/domain/common/event.ts`: Defines `DomainEventBase` (with `aggregateId: string` required for every event) and the `WithEvents<TEntity, TEvent>` wrapper used to attach pending events to aggregate-producing operations. Deletion uses `WithEvents<null, TEvent>` — `entity: null` marks the aggregate as gone while keeping the result shape uniform.
- Each domain owns its event union (e.g. `app/core/domain/todo/events.ts`) and a `decode*Event(type, payload, meta)` function. Decoders validate the wire payload shape strictly before rebuilding value objects, and return an `EventDecodeResult<TEvent>` — a discriminated `{ ok: true, event } | { ok: false, error }` — rather than throwing, so a single malformed row cannot halt a relay batch. Value-object factory throws are caught inside the decoder and folded into the `error` channel.
- Wire payloads (branded types collapsed to raw strings, e.g. `TodoCreatedEventPayload`) and decoded payloads (branded value objects, e.g. `TodoCreatedEventPayloadDecoded`) are separate types. Fresh events produced by the domain carry the decoded shape; outbox round-trips come back through the decoder.
- Schema evolution is tracked per event via the outbox row's `schema_version` column, branching is done inside the domain's decode function.

### Event Handling (Outbox Pattern)

Uses the Outbox pattern to ensure consistency between entity changes and event publishing. Delivery is **at-least-once** — consumers must be idempotent (typically keyed on `event.id`).

- `app/core/domain/common/ports/outboxRepository.ts`: three ports split by usage surface.
    - `OutboxWriter` — `saveEvents(events)` only. Usecases do not touch it directly; events flow in via `collectEvents` on `ReadWriteContext` so every emission runs through the single write path.
    - `OutboxReader` — extension point for read-only outbox surfaces.
    - `OutboxWorkerRepository extends OutboxReader` — worker-only port carrying `claimPending` + `markProcessed`.
- `claimPending(batchSize, leaseDurationMs, now)` returns an `OutboxClaimBatch` — `{ entries, handle }` — where `handle: OutboxClaimHandle` is an **abstract class with a nominal `unique symbol` brand**. Adapters subclass it (e.g. `class DrizzleClaimHandle extends OutboxClaimHandle { constructor(readonly leaseToken: string) }`) and carry their own per-claim bookkeeping inside that subclass. There are no `as unknown as OutboxClaimHandle` casts: structural assignment is rejected at the type level because of the symbol-keyed brand, and `markProcessed` validates with `instanceof` at runtime so a wrong-adapter handle fails deterministically at the boundary instead of silently no-op'ing.
- `markProcessed(handle, ids)` takes the opaque handle plus the subset of ids actually processed. The adapter scopes the UPDATE to the handle so entries whose lease expired and were re-claimed by another worker are left alone.
- `outbox_events.sequence` is allocated from the single-row `outbox_sequence` table inside the same transaction as the event inserts. Workers claim pending rows ordered by `sequence`, not by `occurredAt`. Allocation correctness depends on SQLite's single-writer serialization; the adapter notes the Turso-migration re-validation requirement inline near `allocateSequenceBlock` so that nobody assumes the same guarantees hold on a multi-writer remote engine.
- `app/core/adapters/drizzleSqlite/repositories/outboxRepository.ts`: Drizzle implementation (reader class + repository subclass) plus the adapter-local `DrizzleClaimHandle` subclass that carries the `leaseToken` string internally.
- `app/core/application/workers/eventRelayWorker.ts`: Event relay worker. Claims a batch under a fresh lease, decodes each row (skipping decode failures via `container.logger.error` so production sinks can alert on the signal), dispatches decoded events with `Promise.allSettled` so one failing consumer doesn't abort the batch, then marks only the successfully-dispatched ids processed against the claim handle.

### Presentation Layer

- **Presentation Layer** (`app/core/presentation/`): Framework-specific cross-cutting utilities.
    - `app/lib/serializedError.ts`: Wire-format envelope (`SerializedError`, `SerializedErrorKind`, `SerializedValidationError`, `FieldErrors`) plus the structural `SerializableError` interface and its `isSerializableError` guard. Lives in `app/lib/` because it is a shared transport contract — every error producer (domain `BusinessRuleError`, application `NotFoundError` / `ConflictError` / …) and the presentation layer that renders them depend on it. Keeping it here breaks an otherwise-circular dependency: presentation never has to enumerate concrete error classes.
    - `app/core/presentation/errorResponse.ts`: Server function error transport (`AppServerError`, `withErrorResponse`, plus type re-exports of `SerializedError` for backwards-compatible imports). Classification is **structural**: `serializeError(error)` checks `isSerializableError(error)` and delegates to the error's own `toSerialized()` method. There is no `instanceof` enumeration of concrete error classes, so adding a new domain or error variant requires zero edits in presentation. `SerializedError` carries `kind` / `code` / `message` plus the optional `retryable` hint and, for the `validation` variant, `fieldErrors`. Re-throws TanStack Router's `redirect()` / `notFound()` sentinels unchanged so navigation works.
    - `app/core/presentation/errorDisplay.ts`: Localized error message helpers for UI (`displayError`, `sanitizeRouteError`). Both dispatch through an exhaustive `Record<SerializedErrorKind, handler>` table so adding a new kind to `SerializedError` is a compile-time error until every handler is updated.
    - `app/core/presentation/useServerAction.ts`: Client hook wrapping a server function call. Accepts `invalidate: "all" | "none" | (() => void | Promise<void>)` (default `"all"`), `autoRetry?: { maxAttempts; baseDelayMs }` that fires only when the serialized error reports `retryable: true`, and exposes `run` / `isPending` / `lastError` / `clearLastError` so UIs can render field-level messages without bookkeeping their own error state.
- Actual UI (routes, components, layouts) lives in `app/routes/` and `app/components/`. The distinction: framework-specific transport/helper code goes in `app/core/presentation/`; concrete React components and route definitions go in `app/routes/` / `app/components/`.

### Example Implementation

- `docs/backend_implementation_example.md`: Detailed examples of types, ports, adapters, application services and context object.
- `docs/frontend_implementation_example.md`: Detailed examples of frontend architecture and server actions.

## Frontend Architecture

TanStack Start application code using:

- TypeScript
- Vite
- React 19
- TanStack Start with React Server Components (`@vitejs/plugin-rsc`)
- TanStack Router (file-based routing)
- Tailwind CSS v4

- UI Components
    - `app/components/${domain}/`: Domain-specific components
    - `app/components/**/*`: Other reusable components
- Pages and Routes
    - `app/routes/`: File-based route components for TanStack Router
    - `app/routes/__root.tsx`: Root document layout
    - `app/routeTree.gen.ts`: Auto-generated route tree (do not edit manually)
    - `app/router.tsx`: Router instance factory (`getRouter`)
- Styles
    - `app/styles/index.css`: Entry point for global styles
- Server Components
    - Default to async server components for data fetching, authorization, and use case invocation
    - Use `cache()` (from `react`) to dedupe per-request fetches
    - Throw `redirect({ to })` / `notFound()` from `@tanstack/react-router` to drive navigation
- Server Functions (mutations)
    - Use `createServerFn` from `@tanstack/react-start` for state-changing operations called from the client
    - Loaders should remain a thin proxy. Do not statically import server-only components or DI modules into route files that enter the client graph; wrap the RSC render in `createServerFn` / server-only modules and have the loader call that bridge.

## Error Handling

### Domain Layer

- `app/core/domain/error.ts`: Defines `BusinessRuleError`. Carries its own `toSerialized()` method that returns a `SerializedError` envelope, so the presentation layer never needs to special-case `instanceof BusinessRuleError`.
- `app/core/domain/${domain}/errorCode.ts`: Error codes are defined within each respective domain.
- Avoids using `try-catch`; throws a `BusinessRuleError` exception when a violation can be determined by the logic.

### Application Layer

- `app/core/application/error.ts`: Defines the following errors:
    - `NotFoundError`
    - `ConflictError`
    - `UnauthenticatedError`
    - `ForbiddenError`
    - `ValidationError`
    - `SystemError`
- Defines error codes for each as needed (e.g., a `NETWORK_ERROR` code for `SystemError`).
- Each subclass exposes a `retryable` getter metadata hint. `SystemError` with `NetworkError` / `ExternalApiError` returns `true`; `ConflictError` returns `false` by default because retry safety depends on the command. Idempotent usecases such as "set this value" should retry OCC conflicts locally after re-reading state instead of letting the transport blindly replay non-idempotent commands.
- `ValidationError` additionally carries an optional `fieldErrors?: Readonly<Record<string, readonly string[]>>`. The `zodIssuesToFieldErrors` helper converts a Zod `issues` array into that shape so every usecase raising `ValidationError` from a Zod failure surfaces the same form-friendly structure.
- Every application-error subclass (and `BusinessRuleError`, and `AppServerError`) implements its own `toSerialized(): SerializedError` so it satisfies the structural `SerializableError` contract without `implements` bookkeeping. Adding a new error class only requires defining a `toSerialized` method — presentation needs no edits.
- Avoid broad `try-catch` in ordinary application logic; use it only at explicit boundaries such as server-function serialization or narrowly-scoped retry loops for idempotent commands.

### Infrastructure Layer

- Throws errors that are defined in the Domain and Application layers.
- Catches exceptions from external systems as necessary and transforms them into the errors defined above.

### Presentation Layer

- Catches all exceptions from the application layer at the server function / route boundary (`withErrorResponse(fn)`).
- Wraps most errors in `AppServerError` (a serializable wire envelope) by routing through `serializeError()` → `isSerializableError()` → the error's own `toSerialized()`. Presentation never imports concrete domain / application error classes — adding a new error variant requires zero edits here. The only exceptions are TanStack Router's `redirect()` / `notFound()` sentinels, which are re-thrown to drive navigation.
- Workers log decode and dispatch failures via the injected `Logger` port (`container.logger.error`) and leave the lease to expire (re-claim on the next tick) rather than `markProcessed`-ing a broken row; `Promise.allSettled` over dispatches keeps one failing consumer from aborting a batch.
- UI code uses `displayError` / `sanitizeRouteError` to render a localized, infra-detail-free message. `useServerAction` exposes `lastError` (the serialized error) so forms can pluck `fieldErrors` out of a validation failure without parsing the message.
