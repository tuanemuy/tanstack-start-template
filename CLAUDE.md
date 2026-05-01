# CLAUDE.md

Guidance for Claude Code working in this repository.

## Principles

- Prioritize type safety; lean on TypeScript's type system fully.
- Prefer stateless, pure functional code in the domain and application layers. Adapter classes are acceptable when they encapsulate a single external resource and keep mutable state internal.
- Make illegal states unrepresentable at the type level before falling back to runtime checks.
- Default to no comments. Add one only when the WHY is non-obvious — a hidden constraint, an invariant, a workaround.
- Keep the surface small. Add a port, decorator, or abstraction only when a concrete second implementation already exists or is imminent.

## Development Commands

- `pnpm dev` — Vite dev server (TanStack Start)
- `pnpm build` — production build (`vite build`)
- `pnpm start` — production server (`node .output/server/index.mjs`)
- `pnpm lint` / `pnpm lint:fix` — Biome lint
- `pnpm format` / `pnpm format:check` — Biome format
- `pnpm typecheck` — type check via `@typescript/native-preview` (tsgo)
- `pnpm test` / `pnpm test:unit` / `pnpm test:integration`

After making changes run `pnpm typecheck`, `pnpm lint:fix`, `pnpm format`.

## Tech Stack

- **Runtime**: Node.js 22.x
- **Frontend**: TanStack Start (React Server Components), TanStack Router, Tailwind CSS v4
- **Database**: libSQL / SQLite with Drizzle ORM. Validated against local file SQLite with WAL journaling. Multi-writer remote backends (e.g. Turso) require re-validating transaction semantics before deployment.

## Core Architecture

Hexagonal architecture with DDD principles.

- **Domain Layer** (`app/core/domain/`): pure business logic, types, port interfaces.
    - `${domain}/entity.ts` — entities.
    - `${domain}/valueObject.ts` — value objects.
    - `${domain}/ports/**.ts` — repository / external API ports. Repository slots are added to `UnitOfWorkContext` in `app/core/application/execution/unitOfWork.ts`.
    - `${domain}/services/**.ts` — domain services.
    - `common/event.ts` — `DomainEventBase`, `EventDecoder`, `WithEvents<TEntity, TEvent>`.
    - `common/pagination.ts` — `Pagination`, `PaginationResult<T>` (types only; runtime validators live at the consumer).
    - `error.ts` — `BusinessRuleError`.
    - `${domain}/errorCode.ts` — per-domain error codes.
    - **Domain code MUST NOT call `new Date()` or `uuidv7()`.** Factories take `now: Date` and any required `id: string` as arguments. The `Clock` and `IdGenerator` ports live in the application layer.
- **Adapter Layer** (`app/core/adapters/`): concrete adapters per provider.
- **Application Layer** (`app/core/application/`): use cases and orchestration.
    - `di/server.ts` — server-only DI container (process-wide singleton). Also exports `readServerConfig()` so out-of-band entry points read env identically to the running server.
    - `${domain}/${usecase}.ts` — application services. Each usecase calls `container.clock.now()` once at the entry point and `container.idGenerator.next()` for each fresh id, then threads those resolved values into every domain operation.
    - `${domain}/view.ts` — DTO projection (collapses discriminated unions / unbrands ids).
    - `ports/clock.ts` — `Clock` (`now(): Date`) + `SystemClock`.
    - `ports/idGenerator.ts` — `IdGenerator` (`next(): string`) + `UuidV7Generator`. UUIDv7 monotonic ordering is what the outbox `(createdAt, id)` ordering relies on.
    - `ports/logger.ts` — `Logger` + `ConsoleLogger`. Cross-cutting observability only; domain / usecase happy paths do not log.
    - `ports/outboxRepository.ts` — `OutboxRepository`. Lives in the application layer (NOT the domain) because the outbox is an infrastructural delivery mechanism.
    - `errors/index.ts` — application-layer errors (`NotFoundError`, `ConflictError`, `ValidationError`, `SystemError`). Adapters import `SystemError` from here too — error types are shared contracts, not behavioral dependencies.
    - `execution/unitOfWork.ts` — single-mode `UnitOfWorkProvider.run(fn)` (see below).
    - `types.ts` — `ServiceArgs<T>`. The template intentionally does not ship a placeholder `AuthedServiceArgs`; introduce one alongside an `auth` port at the point a real usecase needs request-scoped HTTP context.
    - `workers/eventRelayWorker.ts` — polls the outbox, decodes via the registered domain decoders, dispatches via `Promise.allSettled`, marks processed.
    - `workers/outboxPrune.ts` — `pruneOutbox(container, { retentionMs })` deletes processed rows older than the cutoff. The template ships the utility but not the schedule.
    - `__tests__/helpers.ts` — Drizzle-backed in-memory SQLite test container.
    - `__tests__/fakes/` — port fakes (`FakeIdGenerator`, `FakeLogger`).
- **Presentation Layer** (`app/core/presentation/`): framework-specific cross-cutting utilities.
    - `errorResponse.ts` — `AppServerError`, `withErrorResponse`, `serializeError`, `extractSerializedError`.
    - `errorDisplay.ts` — `displayError` / `sanitizeRouteError` / `renderErrorMessage`.
    - `useServerAction.ts` — client hook around server functions.
    - `validator.ts` — `createValidator(schema)` for server-function input boundaries.
- **Shared lib** (`app/lib/`)
    - `serializedError.ts` — wire envelope + the structural `SerializableError` interface and `isSerializableError` guard. Lives outside `core/` because it is a transport contract shared by every error producer and renderer.
    - `error.ts` — `CodedError<TCode>` base shared by `SystemError`, `ApplicationError`, `BusinessRuleError`. Living in `app/lib/` is what lets every layer extend it without violating the hexagonal direction.

### Unit of Work

- `UnitOfWorkProvider.run(fn)` covers every transactional usecase.
- `UnitOfWorkContext` directly enumerates every domain repository the callback can touch plus `collectEvents(events)`. Adding a new domain is a one-line edit here and a wiring edit in the adapter.
- Events handed to `collectEvents` are persisted to the outbox in the same transaction in **call order**.
- `collectEvents` is the only path that reaches the outbox writer from a usecase — domain / application code never calls `OutboxRepository.save` directly.
- `Clock`, `IdGenerator`, `Logger` live on `Container`, not on the UoW context — they have no per-callback lifecycle.

### Retry strategy

The Drizzle adapter retries `SQLITE_BUSY` / `SQLITE_LOCKED` inside `unitOfWork.ts` with exponential backoff. This is a driver-level concern; application code never sees those codes.

There is intentionally no application-level OCC retry decorator. Conflicts (`ConflictError`) propagate to the caller — usecases that want "set X" idempotency wrap their own loop only when they have a concrete need.

### Domain Events

- `common/event.ts` defines `DomainEventBase` and `WithEvents<TEntity, TEvent>`.
- Each event factory takes `id: string` and `occurredAt: Date` as required arguments. Usecases mint via `container.idGenerator.next()` and pass them in.
- Each domain owns its event union and a per-event-type decoder map (`Record<DomainEvent["type"], EventDecoder>`). The relay worker registry consumes the per-event maps directly so adding a new variant without a decoder fails at compile time.
- The wire shape is a plain JSON object whose contents the decoder re-validates. There is no separate "wire vs decoded" type pair and no embedded schema-version field; if a payload shape changes incompatibly, add a new event type rather than versioning the existing one.
- Decoders reapply value-object factories to stored payloads. **Tightening** an invariant can retroactively reject historical outbox rows — keep changes additive (looser) or introduce a new event type.
- Aggregate deletion that produces no successor entity emits the `*.deleted` event directly from the usecase (e.g. `deleteTodo`) rather than going through a domain method.

### Event Handling (Outbox Pattern)

Delivery is **at-least-once**. Consumers must be idempotent (typically keyed on `event.id`).

- `ports/outboxRepository.ts`: `save` (UoW transaction), `listPending`, `markProcessed`, `pruneProcessed`.
- `adapters/drizzleSqlite/repositories/outboxRepository.ts` implements the port. The adapter takes a Drizzle `Executor` so the same class works inside a transaction or against the bare DB.
- `workers/eventRelayWorker.ts` polls, decodes, dispatches via `Promise.allSettled`, logs failures via `container.logger.error`, and calls `markProcessed` for the successful ids only.
- `workers/outboxPrune.ts`: `pruneOutbox(container, { retentionMs })`. Raw milliseconds is the canonical unit. Safe to run concurrently with the relay worker.
- The template assumes a single relay worker process. Running multiple concurrent workers can double-dispatch.
- Rows with `processed_at IS NOT NULL` are retained for audit; the template ships `pruneOutbox` but **does not schedule it**.

### State transitions

Status transitions are guarded twice on purpose:
- The domain `Todo.complete(active)` / `Todo.reopen(completed)` only typecheck against the correct variant — illegal transitions are a compile-time error.
- The usecase short-circuits on `null` from `setStatusIfNeeded` to make "set status to X" idempotent without bumping `version` / emitting a redundant event.

The two layers do different jobs (illegal-vs-redundant), so the duplication is intentional.

### Frontend Architecture

TanStack Start with React 19 / RSC, TanStack Router (file-based), Tailwind v4.

- UI: `app/components/${domain}/`, `app/components/**/*`.
- Routes: `app/routes/`, root layout `app/routes/__root.tsx`, generated tree `app/routeTree.gen.ts`, instance factory `app/router.tsx`.
- Styles: `app/styles/index.css`.
- Server Components: default to async server components for fetching / authorization / usecase invocation. Use `cache()` from `react` to dedupe per-request fetches. Throw `redirect({ to })` / `notFound()` from `@tanstack/react-router` to drive navigation.
- Server Functions (mutations): `createServerFn` from `@tanstack/react-start`. `.handler(...)` already runs server-only — invoke usecases directly. Wrap in `withErrorResponse(...)` so any thrown value becomes the `AppServerError` wire envelope. Loaders should remain a thin proxy. Do not statically import server-only components or DI modules into route files that enter the client graph; wrap the RSC render in `createServerFn` and have the loader call that bridge.

## Error Handling

### Domain Layer

- `domain/error.ts` defines `BusinessRuleError<TCode extends string = never>`. Each throw site narrows `TCode` to its domain's literal-union code type. `isBusinessRuleError` narrows to `BusinessRuleError<string>` for the generic catch case.
- `BusinessRuleError` carries `toSerialized()` — presentation never enumerates classes via `instanceof`.

### Application Layer

- `errors/index.ts` defines the abstract `ApplicationError` (HTTP status family) plus `NotFoundError` (404), `ConflictError` (409), `ValidationError` (422). `SystemError` (500-class) lives here too.
- `ApplicationError` exposes `abstract get httpStatus(): number`. `withErrorResponse` calls `setResponseStatus(error.httpStatus)` for any application error before throwing the wire envelope, so adding a new variant requires nothing more than choosing its status.
- Each subclass's `code` is a plain string. Per-class enums were dropped — domain enums (e.g. `TodoErrorCode`) and the transport `SerializedErrorKind` cover all the categorisation that matters. `SystemErrorCode` is kept because it drives the runtime `retryable` classification.
- `ValidationError.fieldErrors` is optional. `zodIssuesToFieldErrors` converts Zod issues into that shape.
- Every error class implements `toSerialized()` so the presentation layer can serialize structurally.
- Avoid broad `try / catch` in ordinary application logic. Use it only at explicit boundaries: server-function serialization, decoder per-row tolerance in the relay worker.

### Infrastructure Layer

- Throws domain / application errors. `mapDbError(message, fn)` wraps Drizzle calls and converts unrecognized exceptions into `SystemError(DatabaseError)`. `ConflictError` from optimistic-lock predicates passes through untouched.

### Presentation Layer

- `withErrorResponse(fn)` wraps thrown values in `AppServerError` via `serializeError` → `isSerializableError` → `toSerialized`. Status comes from `error.httpStatus` (only the abstract `ApplicationError` base is touched). `redirect()` / `notFound()` sentinels are re-thrown to drive navigation.
- Workers log decode/dispatch failures via the injected `Logger` and leave the row pending. `Promise.allSettled` keeps one bad consumer from aborting the batch.
- UI calls `displayError(error)` / `sanitizeRouteError(error)`. `useServerAction` exposes `lastError` so forms can pluck `fieldErrors` out of a validation failure without parsing the message.

## Example Implementation

- `docs/backend_implementation_example.md`
- `docs/frontend_implementation_example.md`
