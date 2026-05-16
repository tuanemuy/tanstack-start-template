# CLAUDE.md

Guidance for Claude Code working in this repository.

## Principles

- Prioritize type safety; lean on TypeScript's type system fully.
- Prefer stateless, pure functional code in domain / application layers. Adapter classes are fine when they encapsulate a single external resource and keep mutable state internal.
- Make illegal states unrepresentable at the type level before falling back to runtime checks.
- Default to no comments. Add one only when the WHY is non-obvious — a hidden constraint, an invariant, a workaround. Library-level JSDoc on exported APIs is welcome.
- Validate at the boundaries (transport in, value-object construction); trust the static type in between.
- Keep cross-cutting concerns (clock, id generation, logging) behind ports so domain and application code stays deterministic and testable.

## Development Commands

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` / `pnpm lint:fix` / `pnpm format` / `pnpm format:check` (Biome)
- `pnpm typecheck` (`tsgo` via `@typescript/native-preview`)
- `pnpm test` / `pnpm test:unit` / `pnpm test:integration`

After changes: `pnpm typecheck && pnpm lint:fix && pnpm format`.

## Architecture

Hexagonal architecture with DDD. Dependencies point inward: presentation → application → domain, with adapters implementing ports defined inward of them.

### Layers

- **Domain** (`app/core/domain/`) — Pure business logic: entities, value objects, domain services, port interfaces, domain events. No I/O, no framework, no ambient time / id generation. Throws `BusinessRuleError` for invariant violations.
- **Application** (`app/core/application/`) — Use cases that orchestrate the domain. Defines ports for cross-cutting concerns (clock, id generation, logging), the unit-of-work abstraction, and application-level errors. DTO projection for the presentation layer lives here.
- **Adapters** (`app/core/adapters/`) — Concrete implementations of ports per provider (DB, external APIs, etc). Translate driver-specific errors into the shared error contracts.
- **Presentation** (`app/core/presentation/`) — Framework-specific cross-cutting utilities for TanStack Start: server-function entry point, error-response middleware, transport-boundary input validation, error display helpers. The full `SerializedError` union is assembled here from each layer's variants.

### Not a layer

- `app/lib/` — Shared structural primitives (e.g. the `CodedError` base, structural pieces of the serialized-error contract) that every layer may extend. Living outside the layered tree is what lets all four layers depend on it without violating the inward-only direction.

### Frontend

TanStack Start with React 19 / RSC, TanStack Router (file-based routes), Tailwind v4. Components live under `app/components/`, routes under `app/routes/`. Default to async server components for data fetching and usecase invocation; use server functions (via the presentation-layer entry point) for mutations and loader bridges; drive client mutations through React 19 primitives directly rather than custom wrappers.

## Key concepts

Each of these is enforced in code and documented in library-level JSDoc at the relevant module — read there for the details.

- **Unit of Work** — every transactional usecase runs inside `UnitOfWorkProvider.run(fn)`; the context exposes the repositories the callback may touch and the only path to enqueue domain events.
- **Outbox / domain events** — events collected during a UoW are persisted transactionally and dispatched out-of-band by a relay worker. Delivery is at-least-once with no ordering guarantee; consumers must be idempotent. The relay worker claims rows under a lease so multiple workers cannot dispatch the same row, and a crashed worker's claim is reclaimable once the lease lapses.
- **Retry strategy** — driver-level transient errors are retried inside the adapter; application code never sees them. There is intentionally no application-level OCC retry decorator.
- **Input validation** — validated at exactly two points: the transport boundary (shape / DoS) and value-object construction (business invariants). Usecases trust the static type in between. On the frontend the transport boundary is the route's `validateSearch` (URL params) or `serverAction`'s `inputValidator` (client-posted payloads); `serverData` is **internal-only** and intentionally schemaless — never feed unvalidated external input through it.

## Error handling

- Errors are class hierarchies that each carry their own `kind`-tagged serialized form (`toSerialized()`). The presentation layer serializes structurally — no `instanceof` enumeration of concrete classes.
- HTTP status mapping is presentation-only, driven by the serialized `kind`. Errors themselves do not carry transport concerns.
- Avoid broad `try / catch` in ordinary application logic. Use it only at explicit boundaries (server-function serialization, per-row tolerance in workers).

### Cross-layer catch policy

- **adapter → application**: adapters catch driver-specific errors and translate them into the shared error contracts. Application code never sees provider-native errors.
- **domain → application**: domain errors flow through usecases unchanged. Do not re-translate at the usecase boundary — invariant violations and transport-shape violations are intentionally distinct kinds.
- **application → presentation**: the server-function boundary catches and serializes any thrown error structurally via its `kind`-tagged form. Usecases themselves do not serialize.
- **worker → root**: workers wrap per-row processing in `try / catch` for partial-failure tolerance. This is the only place a broad `catch` is expected in application-layer code.

## Reference runtimes

The template ships three reference runtime wirings — Node.js + libSQL (single process), Cloudflare Workers + D1 + Queues, and AWS Lambda + Turso + SQS — as worked examples of swapping the adapter and entry-point layers while keeping `domain` / `application` / `presentation` intact. **Pick one and delete the others**, or keep multiple if you genuinely need multiple targets; the template does not assume you maintain a multi-runtime deployment.

Entry points by runtime:

- **Cloudflare**: `app/server.cloudflare.ts` (fetch), `app/worker/cloudflare/{relay,consumer,pruner,dlq}.ts`, wired by `app/core/application/di/serverCloudflare.ts`.
- **Node**: `app/server.node.ts` (fetch handler + boot), `app/worker/node/runner.ts` (single-process orchestrator of all four roles), `scripts/listen.node.ts` (production launcher), `scripts/migrate.node.ts` (libSQL migrator). Wired by `app/core/application/di/serverNode.ts`.
- **AWS**: `app/server.aws.ts` (API Gateway → fetch), `app/worker/aws/{relay,consumer,pruner,dlq}.ts` (thin role-typed wrappers over shared `handlers.ts`), `scripts/migrate.aws.ts` (Turso migrator), `infra/aws/` (CDK stack). Wired by `app/core/application/di/serverAws.ts`.

Per-runtime operational guidance lives in `docs/runtime_node.md`, `docs/runtime_cloudflare.md`, and `docs/runtime_aws.md`. The Node runtime is the default for `pnpm dev` / `pnpm build` / `pnpm start`; the CF runtime is reached through the `:cf` script suffix and the AWS runtime through `:aws`.

To target a different runtime (Cloud Run, Fly Machines, etc.), add a new adapter group under `app/core/adapters/{provider}/` and a paired entry point — the inward layers stay put. Existing adapters can usually be reused across runtimes (libSQL works on Lambda / Cloud Run unchanged); the swap is the entry + DI wiring, not the whole stack.

## Examples

具体的な実装パターンは `docs/backend_implementation_example.md` / `docs/frontend_implementation_example.md` を参照。
