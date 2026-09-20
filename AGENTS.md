# AGENTS.md

Guidance for coding agents working in this repository.

## Principles

- Prioritize type safety; lean on TypeScript's type system fully.
- Prefer stateless, pure functional code in domain / application layers. Adapter classes are fine when they encapsulate a single external resource and keep mutable state internal.
- Make illegal states unrepresentable at the type level before falling back to runtime checks.
- Default to no comments. Add one only when the WHY is non-obvious — a hidden constraint, an invariant, a workaround. Library-level JSDoc on exported APIs is welcome.
- Validate at the boundaries (transport in, value-object construction); trust the static type in between.
- Keep cross-cutting concerns (clock, id generation, logging) behind ports so domain and application code stays deterministic and testable.

## Workspace layout

pnpm monorepo. One lockfile at the root; packages resolve each other via package `exports` pointing straight at `.ts` sources (no build step for internal packages). `@repo/core` exposes a single flat rule — `"./*": "./src/*.ts"` — so every subpath maps 1:1 to a file and there is no barrel to import from.

- `packages/core` (`@repo/core`) — domain / application / adapters + shared `lib/` primitives. Framework-free; imported everywhere as `@repo/core/*`.
- `apps/web` (`@repo/web`) — the TanStack Start app: routes, components, the presentation layer, per-runtime server entries and workers, `scripts/`, and all runtime configs (vite / wrangler / drizzle / Dockerfile).
- `infra/aws` (`@repo/infra-aws`) — CDK stack.
- `infra/cloudflare/pulumi` (`@repo/infra-cloudflare`) — Pulumi resources and Wrangler-config rendering. Pinned to TypeScript 6 on purpose: `@pulumi/pulumi` peers on `typescript <7` because its Node runtime uses the compiler's programmatic API, which TypeScript 7.0 does not ship. Do not bump it with the rest of the workspace until Pulumi widens that range.
- `infra/gcp` — Terraform only; it is not an npm package and lives outside the workspace.
- Root — shared tooling only: Biome, TypeScript, vitest orchestration configs, delegating scripts. `apps/web` and `packages/core` declare no `typescript` of their own — their `tsc` is the root's (pnpm puts the workspace root's `node_modules/.bin` on every package script's `PATH`), so there is one compiler version to bump; only the `infra/*` packages pin their own. `@types/*` are publicly hoisted (see `pnpm-workspace.yaml`) so `.d.ts` files inside the pnpm store can resolve `react` / `vitest` types.

A future app (MCP server, CLI, …) is a new `apps/*` package that declares `"@repo/core": "workspace:*"` and owns its DI wiring or reuses one from `packages/core/src/application/di/`. No tsconfig `paths` mirror is needed.

## Development Commands

Run from the repo root — root scripts delegate to `@repo/web` where relevant:

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` / `pnpm lint:fix` / `pnpm format` / `pnpm format:check` (Biome, whole repo)
- `pnpm typecheck` (root `tsc` for the vitest configs + `pnpm -r typecheck` across packages)
- `pnpm test` / `pnpm test:unit` / `pnpm test:integration` (vitest runs at the root, spanning `apps/web` and `packages/core`)
- Web-only scripts not delegated at the root: `pnpm --filter @repo/web <script>` (or run inside `apps/web`)

After changes: `pnpm typecheck && pnpm lint:fix && pnpm format`.

## Architecture

Hexagonal architecture with DDD. Dependencies point inward: presentation → application → domain, with adapters implementing ports defined inward of them.

### Layers

- **Domain** (`packages/core/src/domain/`) — Pure business logic: entities, value objects, domain services, port interfaces, domain events. No I/O, no framework, no ambient time / id generation. Throws `BusinessRuleError` for invariant violations.
- **Application** (`packages/core/src/application/`) — Use cases that orchestrate the domain. Defines ports for cross-cutting concerns (clock, id generation, logging), the unit-of-work abstraction, and application-level errors. DTO projection for the presentation layer lives here.
- **Adapters** (`packages/core/src/adapters/`) — Concrete implementations of ports per provider (DB, external APIs, etc). Translate driver-specific errors into the shared error contracts.
- **Presentation** (`apps/web/app/presentation/`) — Framework-specific cross-cutting utilities for TanStack Start: server-function entry point, error-response middleware, transport-boundary input validation, error display helpers. The full `SerializedError` union is assembled here from each layer's variants.

### Not a layer

- `packages/core/src/lib/` — Shared structural primitives (e.g. the `CodedError` base, structural pieces of the serialized-error contract) that every layer may extend. Living outside the layered tree is what lets all four layers depend on it without violating the inward-only direction.

### Frontend

TanStack Start with React 19 / RSC, TanStack Router (file-based routes), Tailwind v4. Components live under `apps/web/app/components/`, routes under `apps/web/app/routes/`. Default to async server components for data fetching and usecase invocation; use server functions (via the presentation-layer entry point) for mutations and loader bridges; drive client mutations through React 19 primitives directly rather than custom wrappers.

Mutations are a three-layer concern: server component fetches → `"use client"` island for interaction → React 19 primitives (`useActionState` / `useTransition` / `useOptimistic`) for instant feedback. The third layer is mandatory — a server function wired straight to a `<form>` with no optimistic/pending UI is the default failure mode that yields a sluggish, round-trip-only app.

Ownership follows the kind of change. **In-item mutations** (a field toggle, an inline rename) don't change list membership and the leaf survives them, so the leaf owns its server function, its item-local `useOptimistic`, and its error UI. **List-membership changes** (add/remove) can't use an item-local `useOptimistic` — they're a parent-state change — so move list ownership to a client island seeded by the loader (`apps/web/app/components/todo/TodoBoard`) and have the owner run the server function for them. Delete in particular must run in the owner: the optimistic removal unmounts the leaf before the request settles, so a leaf-owned delete would discard its own error UI. Add is dispatched from the form's action because the form lives outside the list and survives the round trip. Every mutation reconciles by awaiting `useReconcile()` (`apps/web/app/presentation/reconcile.ts`) inside its transition — `router.invalidate({ sync: true })`, not a bare `router.invalidate()`. A bare call treats a loaded route as stale-while-revalidate and resolves before the fresh data exists, so the transition ends early and the optimistic state reverts to stale data until the background refresh lands. With `sync` it resolves once the fresh data is committed, and the optimistic revert and the refetched data land in one commit. `apps/web/app/components/todo/` is the reference for all of this.

Loading fallbacks come in two kinds, by scope. **Per-fragment streaming** is for content tied 1:1 to a URL (lists, details): the loader forwards the `renderServerComponent(...)` promise **without awaiting** it, so navigation settles instantly and the fragment streams in under `<Suspense fallback={<Skeleton/>}>` (resolved client-side by `Deferred`/`use()`). `apps/web/app/routes/todo/index.tsx` is the reference; skeletons live under `apps/web/app/components/ui/Skeleton` (generic) and `apps/web/app/components/todo/TodoListSkeleton` (shaped to the real DOM so it swaps in without layout shift). **Route-level pending** (`router.tsx`'s `defaultPendingComponent` + `defaultPendingMs`/`defaultPendingMinMs`) is the navigation fallback for any route whose loader genuinely *blocks*; a route that streams (like `/todo`) settles its loader immediately and never triggers it. Keep the two roles distinct: skeletons cover the initial/streaming load, the optimistic primitives above cover post-mount mutations. `apps/web/app/components/ui/Deferred` encodes the rules that keep them from colliding — use it rather than a bare `<Suspense>` + `use()`. It adopts each new loader promise inside a transition, because the fresh unresolved promise a reconcile yields would otherwise re-suspend the boundary, flash the skeleton, and remount the island along with its optimistic state; that same adoption, scheduled while the mutation is pending, is what lets React fold the optimistic revert into the commit that shows the new data (`useDeferredValue` does not — its render is not entangled with the mutation). And it wraps only the fallback → content reveal in `<ViewTransition>`: `useOptimistic` commits are urgent, so React never animates them, and a transition around mutating content just holds the reconciling commit back.

## Key concepts

Each of these is enforced in code and documented in library-level JSDoc at the relevant module — read there for the details.

- **Unit of Work** — every transactional usecase runs inside `UnitOfWorkProvider.run(fn)`; the context exposes the repositories the callback may touch and the only path to enqueue domain events.
- **Outbox / domain events** — events collected during a UoW are persisted transactionally and dispatched out-of-band by a relay worker. Delivery is at-least-once with no ordering guarantee; consumers must be idempotent. The relay worker claims rows under a lease so multiple workers cannot dispatch the same row, and a crashed worker's claim is reclaimable once the lease lapses.
- **Idempotent create** — the caller mints the aggregate id and resends the same one on failure; the creating usecase answers "same id, same content" as a replay (no write, no event) and "same id, different content" as a `ConflictError`. The client keeps the id across a failed attempt — a fresh id per submit would defeat it. `packages/core/src/application/todo/createTodo.ts` and `apps/web/app/components/todo/CreateTodoForm` are the reference.
- **Retry strategy** — a failed database operation is never retried, in the adapter or above it. Adapters translate the driver error (`SystemError("DATABASE_ERROR")`, `ConflictError`) and let it surface; the caller may resend, which OCC and idempotent create make safe. Contention is designed out instead of retried: libSQL flushes every atomic write through one synchronous `db.batch()` (`docs/runtime_node.md`), and D1 leaves transient conditions to the binding. Redelivering a domain event is the outbox relay's job, not a retry of the write. There is intentionally no application-level OCC retry decorator.
- **Input validation** — validated at exactly two points: the transport boundary (shape / DoS) and value-object construction (business invariants). Usecases trust the static type in between. On the frontend the transport boundary is the route's `validateSearch` (URL params) or `serverAction`'s `inputValidator` (client-posted payloads); `serverData` is **internal-only** and intentionally schemaless — never feed unvalidated external input through it. A caller-chosen aggregate id follows the same rule: its format is owned by the `IdGenerator` port, so the transport boundary parses it (`parseGeneratedId`, `apps/web/app/presentation/validator.ts`) into the `GeneratedId` brand the creating usecase requires — an id adapters would refuse to rehydrate cannot be passed to it.

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

The template ships five reference runtime wirings — Node.js + libSQL (single process), Cloudflare Workers + D1 + Queues, Cloudflare Workers + Durable Objects + Queues (DO-local outbox relayed from the DO's Alarm), AWS Lambda + Turso + SQS, and GCP Cloud Run + Turso + Pub/Sub — as worked examples of swapping the adapter and entry-point layers while keeping `domain` / `application` / `presentation` intact. **Pick one and delete the others**, or keep multiple if you genuinely need multiple targets; the template does not assume you maintain a multi-runtime deployment.

Entry points by runtime:

- **Cloudflare (D1)**: `apps/web/app/server.cloudflare.ts` (fetch), `apps/web/app/worker/cloudflare/{relay,consumer,pruner,dlq}.ts`, wired by `packages/core/src/application/di/serverCloudflare.ts`.
- **Cloudflare (Durable Objects)**: `apps/web/app/server.cloudflare-do.ts` (fetch), `apps/web/app/durable-objects/todoState.ts` (SQLite-backed DO owning aggregate + outbox + idempotency; its Alarm is the relay AND the pruner — no relay/pruner Workers, no cron), `apps/web/app/worker/cloudflare-do/{consumer,dlq}.ts`, wired by `packages/core/src/application/di/serverCloudflareDo.ts` over the adapters in `packages/core/src/adapters/do/`.
- **Node**: `apps/web/app/server.node.ts` (fetch handler + boot), `apps/web/app/worker/node/runner.ts` (single-process orchestrator of all four roles), `apps/web/scripts/listen.node.ts` (production launcher), `apps/web/scripts/migrate.node.ts` (libSQL migrator). Wired by `packages/core/src/application/di/serverNode.ts`.
- **AWS**: `apps/web/app/server.aws.ts` (API Gateway → fetch), `apps/web/app/worker/aws/{relay,consumer,pruner,dlq}.ts` (thin role-typed wrappers over shared `handlers.ts`), `apps/web/scripts/migrate.aws.ts` (Turso migrator), `infra/aws/` (CDK stack). Wired by `packages/core/src/application/di/serverAws.ts`.
- **GCP**: `apps/web/app/server.gcp.ts` (Cloud Run role dispatcher), `apps/web/app/worker/gcp/{relay,consumer,dlq}.ts`, `apps/web/scripts/migrate.gcp.ts` (Turso migrator), `infra/gcp/` (Terraform examples). Wired by `packages/core/src/application/di/serverGcp.ts`.

Per-runtime operational guidance lives in `docs/runtime_node.md`, `docs/runtime_cloudflare.md`, `docs/runtime_cloudflare_do.md`, `docs/runtime_aws.md`, and `docs/runtime_gcp.md`. The Node runtime is the default for `pnpm dev` / `pnpm build` / `pnpm start`; the other runtimes use the `:cf`, `:do`, `:aws`, and `:gcp` suffixes.

To target a different runtime (Cloud Run, Fly Machines, etc.), add a new adapter group under `packages/core/src/adapters/{provider}/` and a paired entry point — the inward layers stay put. Existing adapters can usually be reused across runtimes (libSQL works on Lambda / Cloud Run unchanged); the swap is the entry + DI wiring, not the whole stack.

## Examples

具体的な実装パターンは `docs/backend_implementation_example.md` / `docs/frontend_implementation_example.md` を参照。
