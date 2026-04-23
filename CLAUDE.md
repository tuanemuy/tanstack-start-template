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
- `pnpm test` - Run tests with Vitest
- `TEST_DOMAIN=${domain(lowercase)} pnpm test:domain` - Run tests with Vitest for a specific domain

## Code Quality

- Run `pnpm typecheck`, `pnpm run lint:fix` and `pnpm run format` after making changes to ensure code quality and consistency.

## Tech Stack

- **Runtime**: Node.js 22.x
- **Frontend**: TanStack Start (React Server Components enabled), TanStack Router, Tailwind CSS, Conform
- **Database**: Turso with Drizzle ORM

## Core Architecture

Hexagonal architecture with domain-driven design principles:

- **Domain Layer** (`app/core/domain/`): Contains business logic, types, and port interfaces
    - `app/core/domain/${domain}/entity.ts`: Domain entities
    - `app/core/domain/${domain}/valueObject.ts`: Value objects
    - `app/core/domain/${domain}/ports/**.ts`: Port interfaces for external services (repositories, exteranl APIs, etc.)
    - `app/core/domain/${domain}/services/**.ts`: Domain services for complex business logic
- **Adapter Layer** (`app/core/adapters/`): Contains concrete implementations for external services
    - `app/core/adapters/${externalServiceProvider}/**.ts`: Adapters for external services like databases, APIs, etc.
- **Application Layer** (`app/core/application/`): Contains use cases and application services
    - `app/core/application/di/(server|client).ts`: Dependency injection setup
    - `app/core/application/${domain}/${usecase}.ts`: Application services that orchestrate domain logic. Each service is a function that takes a context object.
    - `app/core/domain/error.ts`: Error types for business logic
    - `app/core/domain/${domain}/errorCode.ts`: Error codes for each domain
    - `app/core/application/error.ts`: Error types for application layer
    - `app/core/application/__tests__/helpers.ts`: Test helpers for application services

### Unit of Work

- `app/core/application/unitOfWork.ts`: Defines the `UnitOfWorkProvider` port plus the `ReadonlyContext` / `ReadWriteContext` shapes.
- `ReadonlyContext` exposes the `*Reader` subset of every port; `save` / `delete` / `saveEvents` are not callable in `{ mode: "readonly" }` at the **type level** (no runtime traps).
- `ReadWriteContext` adds `collectEvent(event)` for the Outbox pattern. Events collected in the callback are persisted to the outbox in the same transaction.
- `app/core/application/retryingUnitOfWork.ts`: `RetryingUnitOfWorkProvider` decorator that retries transient contention errors. The adapter-specific `isRetryable` predicate is injected at wire time (`createContainer`).
- Adapters (e.g. `app/core/adapters/drizzleSqlite/unitOfWork.ts`) implement the bare port; retry is composed on top via the decorator.

### Domain Events

- `app/core/domain/common/event.ts`: Defines `DomainEventBase` and the `WithEvents<TEntity, TEvent>` wrapper used to attach pending events to aggregate-producing operations.
- Each domain owns its event union (e.g. `app/core/domain/todo/events.ts`) and a `decode*Event(type, payload, meta)` function that re-runs wire-format payloads through value-object factories before consumers see them.
- Schema evolution is tracked per event via the outbox row's `schema_version` column, branching is done inside the domain's decode function.

### Event Handling (Outbox Pattern)

Uses the Outbox pattern to ensure consistency between entity changes and event publishing. Delivery is **at-least-once** — consumers must be idempotent (typically keyed on `event.id`).

- `app/core/domain/common/ports/outboxRepository.ts`: `OutboxReader` + `OutboxRepository` port. `claimPending` returns `ClaimedOutboxEntry` values with `leaseToken`; `markProcessed` requires `{ id, leaseToken }` pairs and scopes its update to that token so late-arriving workers cannot silently drop work re-claimed by another worker after lease expiry.
- `app/core/adapters/drizzleSqlite/repositories/outboxRepository.ts`: Drizzle implementation (reader class + repository subclass).
- `app/core/application/workers/eventRelayWorker.ts`: Event relay worker. Claims a batch under a fresh lease, dispatches each event, then marks the batch processed in a single round-trip.

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
- Conform

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
    - Loaders should remain a thin proxy: call `renderServerComponent` from `@tanstack/react-start/rsc` to stream the RSC payload of a server component into the route

## Error Handling

### Domain Layer

- `app/core/domain/error.ts`: Defines `BusinessRuleError`.
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
- Avoids using `try-catch`; throws these exceptions when a failure can be determined by the application logic.

### Infrastructure Layer

- Throws errors that are defined in the Domain and Application layers.
- Catches exceptions from external systems as necessary and transforms them into the errors defined above.

### Presentation Layer

- Catches all exceptions and transforms them into appropriate responses, such as HTTP errors.
