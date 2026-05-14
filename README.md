# tanstack-start-template

A reference template combining TanStack Start + React 19 (RSC) + DDD / Hexagonal architecture, shipping with **two interchangeable runtimes**:

- **Standalone (Node.js + libSQL)** — single-process, no Docker, no Cloudflare account required. The data file lives at `./data/app.db`.
- **Cloudflare Workers (D1 + Queues)** — multi-worker, edge-distributed, full outbox / queue fan-out.

Domain, application, and presentation code is shared verbatim across both modes. Only the adapter and entry-point layers are swapped.

## Features

- **TanStack Start + React 19 / RSC** — File-based routing (TanStack Router), server components as the default for data fetching, mutations driven through server functions.
- **Hexagonal architecture + DDD** — Enforces a one-way dependency flow `domain → application → adapters → presentation`. Side effects are confined to the boundary via port / adapter separation.
- **Dual runtime** — Node.js + libSQL (`@libsql/client`, `@hono/node-server`) and Cloudflare Workers + D1 + Queues. The same Drizzle SQLite schema feeds both.
- **Outbox pattern** — Domain events are persisted in the same transaction as aggregate writes, then a relay publishes them to consumers. At-least-once delivery, no ordering guarantees, idempotency is the subscriber's responsibility. On CF the relay is a Worker + Queue; on Node it is an in-process scheduler driving an in-memory queue.
- **Drizzle ORM** — Per-runtime adapters translate driver-specific errors into the shared error contracts.
- **TypeScript / Biome / Vitest / fast-check** — Type checking with `tsgo`, lint and format via Biome, two-tier Vitest setup (unit / integration). Integration tests run on both runtimes.
- **Structured error serialization** — Each layer carries its own `kind`-tagged serialized form; presentation composes the union structurally. HTTP status mapping lives only in presentation.

## Architecture overview

```
                  presentation (TanStack Start server functions / routes)
                            │
                  application (use cases, UoW, ports, outbox / workers)
                            │
        ┌───────────────────┴───────────────────┐
        │                                       │
   adapters/d1 + cloudflare                adapters/libsql + node
   (Workers fetch, Service-Binding         (Node HTTP, in-process
    relay, Queues, cron triggers)          relay, in-memory queue,
                                            interval scheduler)
        │                                       │
   app/server.cloudflare.ts               app/server.node.ts
   app/worker/cloudflare/{relay,          app/worker/node/runner.ts
   consumer,pruner,dlq}.ts                scripts/listen.node.ts
```

Pick the runtime that matches your operational posture; the application code on top is identical.

## Which runtime should I pick?

| Use case                                          | Runtime           |
| ------------------------------------------------- | ----------------- |
| Local hacking, demos, OSS contribution            | Standalone (Node) |
| Self-hosted on a single VPS / container / laptop  | Standalone (Node) |
| Small workloads with a single writer              | Standalone (Node) |
| Multi-region edge presence                        | Cloudflare        |
| Horizontal scale / multi-process workers          | Cloudflare        |
| Production-grade managed Queues + Cron            | Cloudflare        |

When unsure, start with Standalone — the codebase is portable, so promoting to Cloudflare later only changes the entry-point and deployment story.

## Requirements

- Node.js (the `flake.nix` / `.envrc` direnv environment is recommended)
- pnpm
- A Cloudflare account + authenticated `wrangler` (only for the Cloudflare runtime)

## Quick Start

### Option A: Standalone (Node + libSQL) — no Docker, no Cloudflare account

```bash
pnpm install
cp .env.example .env       # edit DATABASE_URL / APP_URL / PORT if needed
pnpm db:migrate            # creates ./data/app.db and applies SQL migrations
pnpm dev                   # vite dev server on http://localhost:3000
```

For a production build:

```bash
pnpm build                 # vite build (Node target)
pnpm start                 # @hono/node-server, reads .env
```

Full reference: [`docs/runtime_node.md`](docs/runtime_node.md).

### Option B: Cloudflare Workers — edge / managed Queues

```bash
pnpm install
cp .dev.vars.example .dev.vars   # wrangler-loaded secrets for local dev
pnpm db:migrate:cf               # apply migrations to the local D1
pnpm dev:cf                      # vite dev server backed by workerd
```

To deploy:

```bash
pnpm deploy:staging:all          # app + relay + consumer + pruner + dlq
```

Full reference: [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md), including the Worker matrix, per-stage wrangler configs, D1 / Queues setup, and the retry-budget model.

## Development commands

```bash
pnpm dev                         # alias of pnpm dev:node (Node runtime)
pnpm dev:node                    # vite dev (Node)
pnpm dev:cf                      # vite dev (Cloudflare / workerd)

pnpm build                       # alias of pnpm build:node
pnpm build:node
pnpm build:cf

pnpm start                       # alias of pnpm start:node
pnpm start:node                  # @hono/node-server
pnpm start:cf                    # wrangler dev (top-level Worker)

pnpm typecheck                   # tsgo (@typescript/native-preview)
pnpm lint                        # Biome lint
pnpm lint:fix                    # Biome check --write
pnpm format                      # Biome format --write
pnpm format:check

pnpm test                        # unit + integration (both runtimes)
pnpm test:unit                   # Vitest (unit)
pnpm test:integration            # node + cf integration suites
pnpm test:integration:node       # Vitest with libSQL temp DB
pnpm test:integration:cf         # Vitest Workers Pool
```

Recommended routine after changes:

```bash
pnpm typecheck && pnpm lint:fix && pnpm format
```

## Database migrations

Migration SQL is the canonical artefact; both runtimes consume the same SQLite-compatible files.

```bash
pnpm db:generate                       # alias of db:generate:cf — generate SQL from app/core/adapters/d1/schema.ts
pnpm db:generate:cf                    # output: app/core/adapters/d1/migrations/
pnpm db:generate:node                  # mirror output to app/core/adapters/libsql/migrations/

pnpm db:migrate                        # alias of db:migrate:node — apply to local libSQL via Drizzle's programmatic migrator
pnpm db:migrate:node
pnpm db:migrate:cf                     # wrangler d1 migrations apply (local D1)
```

The libSQL schema module re-exports the D1 schema, so generation runs once against `drizzle.config.ts` and the libSQL mirror is regenerated only when the SQL needs to be replayed against a libSQL instance. Both adapters share the same SQLite dialect, including OCC `CHECK` constraints and `RETURNING` semantics.

For per-stage D1 migration management (`db:apply:local` / `db:apply:staging` / `db:apply:production`), see [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

## Directory layout

```
app/
├─ core/
│  ├─ domain/         # entities, value objects, port interfaces, domain events
│  ├─ application/    # use cases, UoW, cross-cutting ports (clock / id / logger), DTO projection
│  ├─ adapters/
│  │  ├─ d1/          # Cloudflare D1 repositories + UoW (batched)
│  │  ├─ cloudflare/  # ServiceBindingRelayTrigger, Workers driver implementations
│  │  ├─ libsql/      # libSQL repositories + UoW (interactive transaction)
│  │  └─ node/        # in-process relay trigger, in-memory queue dispatcher
│  └─ presentation/   # server-function entry, error responses, input validation
├─ routes/            # TanStack Router (file-based)
├─ components/
├─ styles/
├─ lib/               # structural primitives shared by every layer (e.g. CodedError)
├─ worker/
│  ├─ cloudflare/     # Cloudflare Workers entries
│  │  ├─ handlers.ts  #   shared worker handler implementations
│  │  ├─ relay.ts     #   relay worker entry (fetch + scheduled)
│  │  ├─ consumer.ts  #   queue consumer entry
│  │  ├─ pruner.ts    #   daily cron entry
│  │  └─ dlq.ts       #   DLQ surfacer
│  └─ node/
│     └─ runner.ts    # Node in-process orchestrator for the four roles above
├─ server.cloudflare.ts # Cloudflare Workers fetch entry
└─ server.node.ts     # Node HTTP fetch entry (used by vite dev + scripts/listen.node.ts)
scripts/
├─ listen.node.ts     # production launcher (loads built bundle, @hono/node-server)
└─ migrate.node.ts    # programmatic libSQL migration runner
docs/                 # implementation pattern examples + per-runtime guides
spec/                 # entry point for the /spec workflow
```

For the deeper rationale, see [`CLAUDE.md`](CLAUDE.md), [`docs/backend_implementation_example.md`](docs/backend_implementation_example.md), and [`docs/frontend_implementation_example.md`](docs/frontend_implementation_example.md).

## License

Undecided (private).
