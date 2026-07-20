# tanstack-start-template

A reference template for building applications with **TanStack Start + React 19 (RSC)** on a **DDD / Hexagonal architecture** foundation.

The goal is to give you a worked example of:

- file-based routing and server components as the default data-fetching path,
- a strict inward dependency flow (`domain → application → adapters → presentation`),
- side effects pushed to the boundary via port / adapter separation,
- structured, layer-tagged error serialization across the stack.

## Features

- **TanStack Start + React 19 / RSC** — File-based routing (TanStack Router), server components as the default for data fetching, mutations driven through server functions.
- **Interactive by default** — Server functions are only the transport; `useActionState` / `useTransition` / `useOptimistic` sit on top for instant feedback. The `/todo` route is the worked example (optimistic toggle, optimistic inline edit, optimistic list add/remove). Skipping this layer is what produces a round-trip-only, sluggish UI.
- **Hexagonal architecture + DDD** — Enforces a one-way dependency flow `domain → application → adapters → presentation`. Side effects are confined to the boundary via port / adapter separation.
- **Drizzle ORM + SQLite dialect** — Schema, migrations, and repositories share a single Drizzle definition. Adapter classes translate driver-specific errors into the shared error contracts.
- **Outbox pattern** — Domain events are persisted in the same transaction as aggregate writes, then a relay publishes them to consumers. At-least-once delivery, no ordering guarantees, idempotency is the subscriber's responsibility.
- **TypeScript / Biome / Vitest / fast-check** — Type checking with `tsgo`, lint and format via Biome, two-tier Vitest setup (unit / integration).
- **Structured error serialization** — Each layer carries its own `kind`-tagged serialized form; presentation composes the union structurally. HTTP status mapping lives only in presentation.

## Directory layout

```
packages/
└─ core/              # @repo/core — framework-free, imported as @repo/core/*
   └─ src/
      ├─ domain/      # entities, value objects, port interfaces, domain events
      ├─ application/ # use cases, UoW, cross-cutting ports (clock / id / logger), DTO projection
      ├─ adapters/    # concrete port implementations (DB, workers, external services)
      └─ lib/         # structural primitives shared by every layer (e.g. CodedError)
apps/
└─ web/               # @repo/web — the TanStack Start app + its runtime configs
   ├─ app/
   │  ├─ presentation/ # server-function entry, error responses, input validation
   │  ├─ routes/       # TanStack Router (file-based)
   │  ├─ components/
   │  ├─ styles/
   │  ├─ worker/       # background-worker entries (relay / consumer / pruner / dlq)
   │  └─ server.*.ts   # server fetch entries
   └─ scripts/         # migration and production launcher scripts
infra/                # aws (CDK, workspace member), cloudflare (Pulumi), gcp (Terraform)
docs/                 # implementation pattern examples + runtime guides
spec/                 # entry point for the /spec workflow
```

For the deeper rationale, see [`CLAUDE.md`](CLAUDE.md), [`docs/backend_implementation_example.md`](docs/backend_implementation_example.md), and [`docs/frontend_implementation_example.md`](docs/frontend_implementation_example.md).

## Reference runtimes

The template ships **two reference runtime wirings** as worked examples of how the adapter and entry-point layers can be swapped while the inward layers stay intact:

- **Node.js + libSQL** — single-process, no Docker, no Cloudflare account required. The data file lives at `./data/app.db`. This is the default for `pnpm dev` / `pnpm build` / `pnpm start`.
- **Cloudflare Workers + D1 + Queues** — multi-worker, edge-distributed, managed queues. Reached via the `:cf` script suffix.

**Pick one and delete the other** when you start a real project. Or, if you genuinely need both targets, keep both. The template does not assume you maintain a dual deployment.

To target a different runtime (AWS Lambda, Cloud Run, Bun, etc.), add a new adapter group under `packages/core/src/adapters/{provider}/` and a paired entry point — the inward layers stay put.

Per-runtime operational guidance: [`docs/runtime_node.md`](docs/runtime_node.md) / [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

## Requirements

- Node.js (the `flake.nix` / `.envrc` direnv environment is recommended)
- pnpm
- A Cloudflare account + authenticated `wrangler` (only if you keep the Cloudflare runtime)

## Quick Start

The default scripts target the Node runtime.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env   # edit DATABASE_URL / APP_URL / PORT if needed
pnpm db:migrate            # creates ./data/app.db and applies SQL migrations
pnpm dev                   # vite dev server on http://localhost:3000
```

For a production build:

```bash
pnpm build
pnpm start
```

If you want to try the Cloudflare wiring instead, see [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

## Development commands

```bash
pnpm dev                         # alias of pnpm dev:node
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

pnpm test                        # unit + integration
pnpm test:unit                   # Vitest (unit)
pnpm test:integration            # integration suites
```

Recommended routine after changes:

```bash
pnpm typecheck && pnpm lint:fix && pnpm format
```

## Database migrations

Migration SQL is the canonical artefact and is shared across the reference runtimes.

```bash
pnpm db:generate                       # generate SQL from the Drizzle schema
pnpm db:migrate                        # apply to local libSQL via Drizzle's programmatic migrator
pnpm db:migrate:cf                     # wrangler d1 migrations apply (local D1)
```

For per-stage D1 migration management, see [`docs/runtime_cloudflare.md`](docs/runtime_cloudflare.md).

## License

Undecided (private).
