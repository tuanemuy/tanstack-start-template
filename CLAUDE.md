# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Principles

- Prioritize type safety by leveraging TypeScript's type system to the fullest extent.
- Prefer a stateless, pure functional programming style for the domain and application layers. Adapter classes are acceptable when they encapsulate a single external resource (DB connection, HTTP client) and keep all mutable state internal.
- Make illegal states unrepresentable at the type level before falling back to runtime checks.
- Keep the surface small. Add a port, decorator, or abstraction only when a concrete second implementation already exists or is imminent.

## Development Commands

- `pnpm dev` - Start the Vite dev server (TanStack Start)
- `pnpm build` - Build for production (`vite build`)
- `pnpm start` - Run the production server (`node .output/server/index.mjs`)
- `pnpm lint` - Lint code with Biome
- `pnpm lint:fix` - Lint code with Biome and fix issues
- `pnpm format` - Format code with Biome
- `pnpm format:check` - Check code formatting with Biome
- `pnpm typecheck` - Type check code with `@typescript/native-preview` (tsgo)
- `pnpm test` - Run all tests with Vitest
- `pnpm test:unit` - Run only unit tests (excludes `*.integration.test.ts`)
- `pnpm test:integration` - Run only integration tests (real SQLite DB)

## Code Quality

- Run `pnpm typecheck`, `pnpm run lint:fix` and `pnpm run format` after making changes to ensure code quality and consistency.

## Tech Stack

- **Runtime**: Node.js 22.x
- **Frontend**: TanStack Start (React Server Components enabled), TanStack Router, Tailwind CSS v4
- **Database**: libSQL / SQLite with Drizzle ORM. Validated against local file SQLite with WAL journaling. Multi-writer remote backends (e.g. Turso) require re-validating transaction semantics before deployment.

## Core Architecture

Hexagonal architecture with domain-driven design principles:

- **Domain Layer** (`app/core/domain/`): Pure business logic, types, and port interfaces.
    - `app/core/domain/${domain}/entity.ts` — Domain entities.
    - `app/core/domain/${domain}/valueObject.ts` — Value objects.
    - `app/core/domain/${domain}/ports/**.ts` — Port interfaces for repositories / external APIs. Each port file also contains a `declare module "@/core/application/execution/unitOfWork"` block that adds its repository slot to `UnitOfWorkContext` (see "Unit of Work" below).
    - `app/core/domain/${domain}/services/**.ts` — Domain services for complex business logic.
    - `app/core/domain/common/event.ts` — `DomainEventBase`, `EventDecoder`, `WithEvents<TEntity, TEvent>` for entity-producing operations that emit events.
    - `app/core/domain/error.ts` — `BusinessRuleError`.
    - `app/core/domain/${domain}/errorCode.ts` — Per-domain error codes.
    - **Domain entities and value objects MUST NOT call `new Date()` or `uuidv7()`.** Factory / behaviour methods take `now: Date` and any required `id: string` as required arguments so the layer stays pure and deterministic under test. The `Clock` and `IdGenerator` ports live in the application layer; the domain only ever receives the resolved `Date` / `string` value.
- **Adapter Layer** (`app/core/adapters/`): Concrete implementations.
    - `app/core/adapters/${provider}/**.ts` — DB / HTTP / external service adapters.
- **Application Layer** (`app/core/application/`): Use cases and orchestration.
    - `app/core/application/di/server.ts` — Server-only DI container (process-wide singleton). Also exports `readServerConfig()` so out-of-band entry points (the seed script, ad-hoc CLIs) read env exactly the same way as the running server — no parallel "fallback to localhost" defaults that could drift.
    - `app/core/application/${domain}/${usecase}.ts` — Application services. Each service is a function taking `{ container, input }`. Usecases call `container.clock.now()` once at the entry point and `container.idGenerator.next()` for each fresh id (aggregate, event), then pass those resolved values into every domain operation that needs them, so all state mutations within a single usecase agree on "the same instant" / share a deterministic id stream by construction.
    - `app/core/application/${domain}/view.ts` — DTO projection of the aggregate (collapses discriminated unions / unbrands ids) for cross-boundary serialization.
    - `app/core/application/ports/clock.ts` — `Clock` port (`now(): Date`) plus `SystemClock`. Consumed only by the application layer.
    - `app/core/application/ports/idGenerator.ts` — `IdGenerator` port (`next(): string`) plus `UuidV7Generator`. Same convention as `Clock`: ambient I/O lives behind a port; the domain only sees the resolved string. UUIDv7 monotonic ordering is what the outbox `(createdAt, id)` ordering relies on.
    - `app/core/application/ports/logger.ts` — `Logger` port (`info` / `warn` / `error` with optional structured `meta`) plus `ConsoleLogger`. Used for cross-cutting observability signals; domain / usecase happy paths do not log.
    - `app/core/application/ports/outboxRepository.ts` — `OutboxRepository` port (`save` / `listPending` / `markProcessed`) used by the outbox pattern. Lives in the application layer (NOT the domain) because the outbox is an infrastructural delivery mechanism, not a domain concept; domain code never imports it.
    - `app/core/application/errors/index.ts` — Application-layer errors (`NotFoundError`, `ConflictError`, `UnauthenticatedError`, `ForbiddenError`, `ValidationError`). Re-exports `SystemError` from `@/lib/systemError` so existing call sites keep working.
    - `app/core/application/execution/unitOfWork.ts` — Single-mode `UnitOfWorkProvider.run(fn)` (see below).
    - `app/core/application/execution/retry.ts` — Generic `retry(fn, options)` utility used inside idempotent usecases (e.g. for OCC conflict re-reads). Driver-level transient retry (`SQLITE_BUSY` etc.) lives inside the Drizzle adapter — application code never sees those codes.
    - `app/core/application/types.ts` — `ServiceArgs<T>`. The template intentionally does not ship a placeholder `AuthedServiceArgs`; introduce one alongside an `auth` port at the point a real usecase needs request-scoped HTTP context.
    - `app/core/application/workers/eventRelayWorker.ts` — Polls the outbox, decodes via the registered domain decoders, dispatches via `Promise.allSettled`, marks processed.
    - `app/core/application/__tests__/helpers.ts` — Test container helpers (Drizzle-backed in-memory SQLite).
    - `app/core/application/__tests__/fakes/` — In-memory port fakes (`FakeIdGenerator`, `FakeLogger`) for tests that need deterministic ids or recorded log entries.
- **Presentation Layer** (`app/core/presentation/`): Framework-specific cross-cutting utilities.
    - `app/core/presentation/errorResponse.ts` — `AppServerError`, `withErrorResponse`, `serializeError`, `extractSerializedError`.
    - `app/core/presentation/errorDisplay.ts` — `displayError` / `sanitizeRouteError` / `renderErrorMessage` (single exhaustive `Record<SerializedErrorKind, handler>` table).
    - `app/core/presentation/useServerAction.ts` — Client hook with optional `autoRetry` for transient errors.
    - `app/core/presentation/validator.ts` — `createValidator(schema)` that turns a Zod failure into `ValidationError` at the server-function input boundary.
- **Shared lib** (`app/lib/`)
    - `app/lib/serializedError.ts` — Wire envelope (`SerializedError` / `SerializedErrorKind` / `FieldErrors`) plus the structural `SerializableError` interface and `isSerializableError` guard. Lives outside `core/` because it is a transport contract shared by every error producer (domain / application) and every renderer (presentation). Keeping it here breaks an otherwise-circular dependency.
    - `app/lib/systemError.ts` — `SystemError` (low-level failures: DB driver, network, storage). Lives here rather than under `core/application/errors/` so that adapter code can import it without reaching upward into the application layer (hexagonal: adapters depend on shared lib + domain ports, not on application modules). Re-exported from `core/application/errors` so existing application-side call sites do not need to know about the new path.
    - `app/lib/error.ts` — `AnyError` base, `fromUnknown`, `formatErrorMessage`. Sits below every layer in the dependency graph.

### Unit of Work

- `app/core/application/execution/unitOfWork.ts` defines `UnitOfWorkProvider.run(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>` — a single mode covers every transactional usecase.
- `UnitOfWorkContext` is intentionally **domain-agnostic** at its declaration site: the application-layer file declares only `collectEvents(events)`. Each domain owns a port file (e.g. `app/core/domain/todo/ports/todoRepository.ts`) that uses TypeScript **declaration merging** to add its own repository slot:

  ```ts
  // app/core/domain/<your-domain>/ports/<repo>.ts
  declare module "@/core/application/execution/unitOfWork" {
    interface UnitOfWorkContext {
      yourRepository: YourRepository;
    }
  }
  ```

  Adding a new domain therefore only edits the new domain's own folder. The application-layer `unitOfWork.ts` is never modified. The Drizzle adapter must (a) wire the corresponding repository instance when it builds the context object and (b) keep a side-effect import of the port file so the augmentation is loaded — both are local edits inside `app/core/adapters/drizzleSqlite/unitOfWork.ts`.
- Events handed to `collectEvents` are persisted to the outbox in the same transaction once the callback resolves, in **call order**.
- `collectEvents` is the only path that reaches the outbox writer from a usecase — there is no raw `OutboxRepository.save` call site in domain or application code.
- `Clock`, `IdGenerator`, and `Logger` are not carried on the UoW context. They live on `Container` because they have no per-callback lifecycle; threading them through the UoW would just be ceremony.

### Retry strategy

Two retry layers exist; they catch different error classes and compose without double-retry.

- **Driver-level transient retry (adapter-internal)** — `app/core/adapters/drizzleSqlite/unitOfWork.ts` retries `SQLITE_BUSY` / `SQLITE_LOCKED` inside `run()` with exponential backoff. This is a SQLite implementation detail, so it lives in the adapter; application code never sees these codes and there is no `RetryingUnitOfWorkProvider` decorator. Other adapters (e.g. a future Postgres backend) own their own transient-failure policy in the same way.
- **Application-level OCC retry (usecase-internal)** — usecases that are idempotent under "set X" semantics (e.g. `changeTodoStatus`) wrap their `unitOfWorkProvider.run(...)` in `retry()` from `execution/retry.ts`, classifying `ConflictError(OptimisticLockFailure)` as retryable. The `now: Date` is captured once before the retry loop so every attempt agrees on the same instant. When the budget is exhausted the original `ConflictError(OptimisticLockFailure)` propagates verbatim — no re-wrapping — so the caller sees the real cause chain.

### Domain Events

- `app/core/domain/common/event.ts` defines `DomainEventBase` (with `id: string` and `aggregateId: string` required for every event) and the `WithEvents<TEntity, TEvent>` wrapper used to attach pending events to entity-producing operations. Aggregate deletion is `WithEvents<null, TEvent>` — `entity: null` marks the aggregate as gone while keeping the result shape uniform. In practice, deletions that do not produce a successor entity (e.g. `deleteTodo`) emit the `*.deleted` event directly from the usecase rather than going through a domain method that would just return `WithEvents<null, …>` with no logic of its own.
- Each event factory takes `id: string` and `occurredAt: Date` as required arguments — no `uuidv7()` / `new Date()` at the bottom of the call stack. Usecases mint the id via `container.idGenerator.next()` and pass it in.
- Each domain owns its event union (e.g. `app/core/domain/todo/events.ts`) and a `decode*Event(type, payload, meta)` function. The decoder validates the wire payload strictly and re-runs each branded field through its value-object factory. **It throws on a malformed row** — the relay worker catches per-row so one bad row does not abort the whole batch.
- The wire shape is a plain JSON object whose contents the decoder re-validates. There is no separate "wire vs decoded" type pair and no embedded schema-version field; if a payload shape ever changes incompatibly, add a new event type rather than versioning the existing one.
- Because the decoder reapplies value-object factories (`TodoTitle.create`, etc.) to stored payloads, **tightening** a value-object invariant (shorter max length, stricter regex) can retroactively reject historical outbox rows. Keep invariant changes additive (looser) when possible; otherwise add a new event type rather than mutating the existing one.

### Event Handling (Outbox Pattern)

Uses the Outbox pattern to ensure consistency between entity changes and event publishing. Delivery is **at-least-once** — consumers must be idempotent (typically keyed on `event.id`).

- `app/core/application/ports/outboxRepository.ts` defines a single `OutboxRepository` port (application-layer, not domain — the outbox is an infrastructural delivery mechanism):
    - `save(events)` — invoked inside the UoW transaction when flushing `collectEvents`.
    - `listPending(limit)` — FIFO list of unprocessed entries for the worker.
    - `markProcessed(ids, now)` — stamp `processed_at` after successful dispatch.
- `app/core/adapters/drizzleSqlite/repositories/outboxRepository.ts` implements the port. The adapter takes a Drizzle `Executor` so the same class works with a transaction handle (called from the UoW's flush) or the bare DB (called from the worker).
- `app/core/application/workers/eventRelayWorker.ts` polls `listPending`, decodes each entry via the domain-owned decoder registry (default: `{ todo: decodeTodoEvent }`), dispatches via `Promise.allSettled`, logs decode/dispatch failures via `container.logger.error`, and calls `markProcessed` for the successfully dispatched ids only.
- This template assumes a single relay worker process. Running multiple concurrent workers can double-dispatch (still acceptable under at-least-once but wasteful). If you scale out, layer a lease / claim mechanism on top.
- Rows with `processed_at IS NOT NULL` are retained for audit/debugging and are NOT cleaned up automatically. Schedule a periodic prune (e.g. a daily job that deletes rows where `processed_at < now() - INTERVAL N DAYS`) sized to your retention requirements before going to production — see the comment on `outboxEvents` in `app/core/adapters/drizzleSqlite/schema.ts`.

### Frontend Architecture

TanStack Start application code using TypeScript, Vite, React 19, TanStack Start with React Server Components, TanStack Router (file-based), Tailwind CSS v4.

- UI Components
    - `app/components/${domain}/` — Domain-specific components.
    - `app/components/**/*` — Other reusable components.
- Pages and Routes
    - `app/routes/` — File-based route components.
    - `app/routes/__root.tsx` — Root document layout.
    - `app/routeTree.gen.ts` — Auto-generated route tree (do not edit manually).
    - `app/router.tsx` — Router instance factory (`getRouter`).
- Styles
    - `app/styles/index.css` — Entry point for global styles.
- Server Components
    - Default to async server components for data fetching, authorization, and use case invocation.
    - Use `cache()` (from `react`) to dedupe per-request fetches.
    - Throw `redirect({ to })` / `notFound()` from `@tanstack/react-router` to drive navigation.
- Server Functions (mutations)
    - Use `createServerFn` from `@tanstack/react-start` for state-changing operations called from the client.
    - `.handler(...)` already runs server-only, so invoke usecases directly from inside the handler — there is no separate `actionHandlers.ts` indirection. Wrap the body in `withErrorResponse(...)` so any thrown value becomes the `AppServerError` wire envelope.
    - Loaders should remain a thin proxy. Do not statically import server-only components or DI modules into route files that enter the client graph; wrap the RSC render in `createServerFn` and have the loader call that bridge.

## Error Handling

### Domain Layer

- `app/core/domain/error.ts` defines `BusinessRuleError`. It carries its own `toSerialized()` method that returns a `SerializedError` envelope, so the presentation layer never needs to special-case `instanceof BusinessRuleError`.
- `app/core/domain/${domain}/errorCode.ts` defines per-domain error codes (`as const` literal unions).
- Domain code throws `BusinessRuleError` rather than catching — violations surface as exceptions and are caught at the boundary.

### Application Layer

- `app/core/application/errors/index.ts` defines:
    - `NotFoundError`, `ConflictError`, `UnauthenticatedError`, `ForbiddenError`, `ValidationError`. `SystemError` is defined in `@/lib/systemError` (so adapters can import it without depending on the application layer) and re-exported here for application-side call sites.
- Each subclass exposes a `retryable` getter (defaulting to `false`). `SystemError` returns `true` for transient codes (`NetworkError`, `ExternalApiError`); `ConflictError` returns `false` because retry safety depends on the command.
- `ValidationError` carries an optional `fieldErrors?: FieldErrors`. The `zodIssuesToFieldErrors` helper converts Zod `issues` into that shape.
- Every application-error subclass (and `BusinessRuleError`, and `AppServerError`) implements `toSerialized(): SerializedError` so the presentation layer can serialize via the structural `SerializableError` contract without `instanceof` enumeration.
- Avoid broad `try / catch` in ordinary application logic. Use it only at explicit boundaries: server-function serialization, narrowly-scoped retry loops for idempotent commands, decoder per-row tolerance in the relay worker.

### Infrastructure Layer

- Throws errors defined in the Domain or Application layers. The `mapDbError(message, fn)` helper wraps Drizzle calls and converts unrecognized exceptions into `SystemError(DatabaseError)` while letting `ConflictError` from optimistic-lock predicates pass through untouched.

### Presentation Layer

- Catches all exceptions at the server-function / route boundary (`withErrorResponse(fn)`) and wraps them in `AppServerError` — a serializable wire envelope built by routing through `serializeError() → isSerializableError() → toSerialized()`. Presentation never imports concrete domain / application error classes; adding a new error variant requires no edits here. The only exceptions are TanStack Router's `redirect()` / `notFound()` sentinels, which are re-thrown verbatim to drive navigation.
- Workers log decode and dispatch failures via the injected `Logger` port and leave the row pending (a future poll re-attempts). `Promise.allSettled` over dispatches keeps one failing consumer from aborting the batch.
- UI code calls `displayError(error)` / `sanitizeRouteError(error)` to render a localized message. `useServerAction` exposes `lastError` (the `SerializedError`) so forms can pluck `fieldErrors` out of a validation failure without parsing the message.

## Example Implementation

- `docs/backend_implementation_example.md` — Detailed examples of types, ports, adapters, and application services.
- `docs/frontend_implementation_example.md` — Detailed examples of frontend architecture and server actions.
