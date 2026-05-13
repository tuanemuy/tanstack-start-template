# tanstack-start-template

A reference template combining TanStack Start + React 19 (RSC) + DDD / Hexagonal architecture + Cloudflare (Workers / D1 / Queues).

## Features

- **TanStack Start + React 19 / RSC** — File-based routing (TanStack Router), server components as the default for data fetching, mutations driven through server functions.
- **Hexagonal architecture + DDD** — Enforces a one-way dependency flow `domain → application → adapters → presentation`. Side effects are confined to the boundary via port / adapter separation.
- **Full Cloudflare stack** — Workers (fetch / cron / queue), D1 (SQLite), Queues. Deployment via Wrangler.
- **Outbox pattern** — Domain events are persisted in the same transaction as aggregate writes, then a cron-driven Relay Worker publishes them to a Queue, and a Consumer Worker drives subscribers. At-least-once delivery, no ordering guarantees, idempotency is the subscriber's responsibility.
- **Drizzle ORM** — The D1 adapter translates driver-specific errors into the shared error contracts.
- **TypeScript / Biome / Vitest / fast-check** — Type checking with `tsgo`, lint and format via Biome, two-tier Vitest setup (unit / integration).
- **Structured error serialization** — Each layer carries its own `kind`-tagged serialized form; presentation composes the union structurally. HTTP status mapping lives only in presentation.

## Requirements

- Node.js (the `flake.nix` / `.envrc` direnv environment is recommended)
- pnpm
- A Cloudflare account (for deployment) and an authenticated `wrangler`

## Setup

```bash
pnpm install
cp .dev.vars.example .dev.vars   # wrangler-loaded secrets for local dev (gitignored)
pnpm db:apply:local              # apply migrations to the local D1
```

`.dev.vars` is auto-loaded by `wrangler dev` (and the workerd-backed `pnpm dev`) and mirrors `wrangler secret put` for production. Non-secret config such as `APP_URL` belongs in the matching `wrangler*.toml` `[vars]`, not in `.dev.vars`.

### Wrangler config layout

| File                       | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `wrangler.toml`            | **Local dev only** — `pnpm dev` / `pnpm build` auto-discover it. Do not deploy from this file. |
| `wrangler.staging.toml`    | Staging deploys (`pnpm deploy:staging*`).                      |
| `wrangler.production.toml` | Production deploys (`pnpm deploy:production*`).                |

Each stage file is a self-contained mirror of `wrangler.toml` with `-staging` / `-production` suffixed on every Cloudflare resource name (Worker name, D1 `database_name`, queue names) so the two stages never collide inside one Cloudflare account.

## Development commands

```bash
pnpm dev                         # Vite dev server (workerd-backed via @cloudflare/vite-plugin)
pnpm build                       # production build
pnpm preview                     # run the built artifact in a local workerd preview

pnpm typecheck                   # tsgo (@typescript/native-preview)
pnpm lint                        # Biome lint
pnpm lint:fix                    # Biome check --write
pnpm format                      # Biome format --write
pnpm format:check

pnpm test                        # unit + integration
pnpm test:unit                   # Vitest (unit)
pnpm test:integration            # Vitest (integration, Workers Pool)
```

Recommended routine after changes:

```bash
pnpm typecheck && pnpm lint:fix && pnpm format
```

## Database migrations (Drizzle + D1)

```bash
pnpm db:generate                       # generate SQL migrations from the schema
pnpm db:apply:local                    # apply to the local D1
pnpm db:apply:staging                  # apply to the staging D1
pnpm db:apply:production               # apply to the production D1
pnpm db:execute:local --file=...       # run an arbitrary SQL file locally
pnpm db:execute:staging --file=...     # run an arbitrary SQL file against staging
pnpm db:execute:production --file=...  # run an arbitrary SQL file against production
```

Migration SQL lives under `app/core/adapters/d1/migrations/`.

## Cloudflare resources (one-time setup)

Cloudflare Queues and D1 databases are not auto-created by `wrangler deploy` — create them once per stage before the first remote deployment, otherwise the Workers will fail to deploy.

```bash
# staging
wrangler d1 create tanstack-start-template-d1-staging
wrangler queues create tanstack-start-template-events-staging
wrangler queues create tanstack-start-template-events-dlq-staging

# production
wrangler d1 create tanstack-start-template-d1-production
wrangler queues create tanstack-start-template-events-production
wrangler queues create tanstack-start-template-events-dlq-production
```

Paste the `database_id` printed by each `wrangler d1 create` into every `[[d1_databases]]` block of the matching `wrangler.<stage>.toml`. Replace the `[vars] APP_URL` placeholders in each stage file before the first deploy — leaving `https://example.com` breaks `buildHead()`'s canonical / OG image URLs.

## Deployment

The main app and four sibling Workers ship from a **per-stage `wrangler.<stage>.toml`** as named environments. Each is deployed independently with `wrangler deploy --config wrangler.<stage>.toml --env <role>`, exposed as `pnpm deploy:<stage>:<role>` scripts.

| Worker      | Responsibility                                                | Wrangler env     |
| ----------- | ------------------------------------------------------------- | ---------------- |
| App (fetch) | TanStack Start HTTP request handling                          | _(top level)_    |
| Relay       | Publish outbox rows — Service Binding kick + safety-net cron  | `--env relay`    |
| Consumer    | Consume the Queue (projections / notifications)               | `--env consumer` |
| Pruner      | Daily cron that prunes processed outbox rows                  | `--env pruner`   |
| DLQ         | Surface events that exhausted the consumer's retry budget     | `--env dlq`      |

```bash
# staging
pnpm deploy:staging                  # app only
pnpm deploy:staging:relay
pnpm deploy:staging:consumer
pnpm deploy:staging:pruner
pnpm deploy:staging:dlq
pnpm deploy:staging:all              # all of the above
pnpm deploy:staging:all:dry          # dry run

# production
pnpm deploy:production               # app only
pnpm deploy:production:relay
pnpm deploy:production:consumer
pnpm deploy:production:pruner
pnpm deploy:production:dlq
pnpm deploy:production:all           # all of the above
pnpm deploy:production:all:dry       # dry run
```

Secrets are scoped per `--config` (and per `--env` for sibling Workers), so set them per stage:

```bash
wrangler secret put MY_SECRET --config wrangler.staging.toml
wrangler secret put MY_SECRET --config wrangler.staging.toml --env relay
wrangler secret put MY_SECRET --config wrangler.production.toml
```

> **Trigger model**: the request path kicks the relay through the `RELAY` Service Binding right after a UoW commit, so newly-persisted events publish without waiting on cron. The relay also runs on a 5-minute safety-net cron in case the Service Binding path fails. Inside a tick, `processOutboxEvents` drains up to `maxIterations` consecutive batches so a backlog is flushed in one trigger rather than 1 batch per minute.

> **Retry budget**: a message reaches the DLQ only after the relay's `DEFAULT_MAX_ATTEMPTS` (publish-side, default 2) and the consumer's `1 + max_retries` (subscriber-side, default 4) are both exhausted. The user-visible attempt count is the **product** of those numbers, so adjust them together when tuning.

> **Wrangler env caveat**: top-level `d1_databases` / `vars` are **not** inherited into named environments. Each `[env.*]` block re-declares them — keep `database_id`, queue names, and `APP_URL` in sync across every block of every stage config. `pnpm cf:types` (re)generates `worker-configuration.d.ts` from `wrangler.toml` only; this also runs automatically on `postinstall` and `predev`.

> **Note**: `wrangler.toml` is dev-only — `pnpm dev` / `pnpm build` auto-discover it via `@cloudflare/vite-plugin`. Do not run `wrangler deploy` against it directly; use the per-stage configs above. For local secrets, drop them into `.dev.vars` (copied from `.dev.vars.example`).

## Directory layout

```
app/
├─ core/
│  ├─ domain/         # entities, value objects, port interfaces, domain events
│  ├─ application/    # use cases, UoW, cross-cutting ports (clock / id / logger), DTO projection
│  ├─ adapters/       # D1 repositories, Workers driver implementations, port implementations
│  └─ presentation/   # server-function entry, error responses, input validation
├─ routes/            # TanStack Router (file-based)
├─ components/
├─ styles/
├─ lib/               # structural primitives shared by every layer (e.g. CodedError)
└─ worker/            # entry points for each Worker (handlers / relay / consumer / pruner)
docs/                 # implementation pattern examples (backend / frontend / test)
spec/                 # entry point for the /spec workflow
```

For the deeper rationale, see `CLAUDE.md` and `docs/backend_implementation_example.md` / `docs/frontend_implementation_example.md`.

## License

Undecided (private).
