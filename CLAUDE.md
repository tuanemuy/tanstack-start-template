# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Principles

- Prioritize type safety by leveraging TypeScript's type system to the fullest extent
- Encourage a stateless, pure functional programming style

## Development Commands

- `pnpm lint` - Lint code with Biome
- `pnpm lint:fix` - Lint code with Biome and fix issues
- `pnpm format` - Format code with Biome
- `pnpm format:check` - Check code formatting with Biome
- `pnpm typecheck` - Type check code with tsc
- `pnpm test` - Run tests with Vitest
- `TEST_DOMAIN=${domain(lowercase)} pnpm test:domain` - Run tests with Vitest for a specific domain

## Code Quality

- Run `pnpm typecheck`, `pnpm run lint:fix` and `pnpm run format` after making changes to ensure code quality and consistency.

## Tech Stack

- **Runtime**: Node.js 22.x
- **Frontend**: React Router v7 Framework mode, Tailwind CSS, Conform
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
    - `app/core/applicaion/error.ts`: Error types for application layer
    - `app/core/application/__tests__/helpers.ts`: Test helpers for application services

### Event Handling (Outbox Pattern)

Uses Outbox pattern to ensure consistency between entity changes and event publishing:

- `app/core/domain/common/ports/outboxRepository.ts`: Outbox repository port
- `app/core/adapters/drizzleSqlite/repositories/outboxRepository.ts`: Drizzle implementation
- `app/core/application/workers/eventRelayWorker.ts`: Event relay worker

### Example Implementation

- `docs/backend_implementation_example.md`: Detailed examples of types, ports, adapters, application services and context object.
- `docs/frontend_implementation_example.md`: Detailed examples of frontend architecture and server actions.

## Frontend Architecture

React Router v7 application code using:

- TypeScript
- Vite
- React 19
- Reacdt Router v7 Framework mode
- Tailwind CSS v4
- Conform

- UI Components
    - `app/components/${domain}/`: Domain-specific components
    - `app/components/**/*`: Other reusable components
- Pages and Routes
    - `app/routes/`: Route components using React Router v7 Framework mode
- Styles
    - `app/styles/index.css`: Entry point for global styles
- Server Actions

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
