# Runtime: Cloudflare Workers (D1 + Queues)

Multi-Worker, edge-distributed runtime. The main app runs in the `app` Worker; outbox publish, queue consumption, daily pruning, and DLQ surfacing each ship as a sibling Worker driven by Service Bindings, Queues, and Cron Triggers.

See [`runtime_node.md`](./runtime_node.md) for the standalone runtime that runs the same code on a single Node process, and [`runtime_cloudflare_do.md`](./runtime_cloudflare_do.md) for the Durable-Object variant that replaces D1 and the relay/pruner Workers with a DO-local outbox relayed from the DO's Alarm.

## Table of contents

- [Quick start](#quick-start)
- [Worker matrix](#worker-matrix)
- [Wrangler config layout](#wrangler-config-layout)
- [One-time Cloudflare resource creation](#one-time-cloudflare-resource-creation)
- [Secrets and vars](#secrets-and-vars)
- [Deployment](#deployment)
- [D1 migrations](#d1-migrations)
- [Queues](#queues)
- [Cron triggers](#cron-triggers)
- [Retry budget](#retry-budget)
- [D1-specific behaviour and the libSQL diff](#d1-specific-behaviour-and-the-libsql-diff)

## Quick start

```bash
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm db:generate:cf                    # generate SQL from the Drizzle schema
pnpm db:migrate:cf                     # apply migrations to the local D1
pnpm dev:cf                            # vite dev backed by workerd (@cloudflare/vite-plugin)
```

`apps/web/.dev.vars` is auto-loaded by `wrangler dev` (and the workerd-backed `pnpm dev:cf`) and mirrors `wrangler secret put` for production. Non-secret config such as `APP_URL` belongs in the matching `apps/web/wrangler*.toml` `[vars]`, not in `.dev.vars`.

## Worker matrix

The main app and four sibling Workers ship from a **per-stage `wrangler.<stage>.toml`** as named environments. Each is deployed independently with `wrangler deploy --config wrangler.<stage>.toml --env <role>`, exposed as `pnpm deploy:<stage>:<role>` scripts.

| Worker      | Responsibility                                                | Wrangler env     | Trigger                                              |
| ----------- | ------------------------------------------------------------- | ---------------- | ---------------------------------------------------- |
| App (fetch) | TanStack Start HTTP request handling                          | _(top level)_    | HTTP                                                 |
| Relay       | Publish outbox rows — Service Binding kick + safety-net cron  | `--env relay`    | `fetch` (Service Binding) + 5-minute Cron Trigger    |
| Consumer    | Consume the Queue (projections / notifications)               | `--env consumer` | Queue consumer (`events`)                            |
| Pruner      | Daily cron that prunes processed outbox rows                  | `--env pruner`   | Daily Cron Trigger                                   |
| DLQ         | Surface events that exhausted the consumer's retry budget     | `--env dlq`      | Queue consumer (`events-dlq`)                        |

Trigger model: the request path kicks the relay through the `RELAY` Service Binding right after a UoW commit, so newly-persisted events publish without waiting on cron. The relay also runs on a 5-minute safety-net cron in case the Service Binding path fails. Inside a tick, `processOutboxEvents` drains up to `maxIterations` consecutive batches so a backlog is flushed in one trigger rather than 1 batch per minute.

## Wrangler config layout

| File                       | Purpose                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/wrangler.toml`            | **Local dev only** — `pnpm dev:cf` / `pnpm build:cf` discover it via `@cloudflare/vite-plugin`. Do not deploy from this file. |
| `apps/web/wrangler.staging.toml`    | Generated staging config (`pnpm cf:render:staging`).                                                    |
| `apps/web/wrangler.production.toml` | Generated production config (`pnpm cf:render:production`).                                              |

Each stage file is a self-contained mirror of `wrangler.toml` with `-staging` / `-production` suffixed on every Cloudflare resource name (Worker name, D1 `database_name`, queue names) so the two stages never collide inside one Cloudflare account.

**Wrangler env caveat**: top-level `d1_databases` / `vars` are **not** inherited into named environments. Each `[env.*]` block re-declares them — keep `database_id`, queue names, and `APP_URL` in sync across every block of every stage config. `pnpm cf:types` (re)generates `worker-configuration.d.ts` from `wrangler.toml` only; this also runs automatically on `postinstall` and `predev:cf`.

## One-time Cloudflare resource creation

Cloudflare Queues and D1 databases are provisioned by the `@repo/infra-cloudflare` Pulumi package. Update the matching `infra/cloudflare/pulumi/resources/Pulumi.<stage>.yaml`, authenticate the Pulumi and Cloudflare CLIs, then create the persistent resources:

```bash
pnpm --filter @repo/infra-cloudflare exec pulumi -C resources -s staging up
pnpm --filter @repo/infra-cloudflare exec pulumi -C resources -s production up
```

Render the ignored, stage-specific Wrangler configs from those Pulumi outputs:

```bash
pnpm cf:render:staging
pnpm cf:render:production
```

Rerun the matching render command whenever a persistent-resource output or public URL changes.

## Secrets and vars

Secrets are scoped per `--config` (and per `--env` for sibling Workers), so set them per stage:

```bash
pnpm --filter @repo/web exec wrangler secret put MY_SECRET --config wrangler.staging.toml
pnpm --filter @repo/web exec wrangler secret put MY_SECRET --config wrangler.staging.toml --env relay
pnpm --filter @repo/web exec wrangler secret put MY_SECRET --config wrangler.production.toml
```

For local dev, drop them into `apps/web/.dev.vars` (copied from `apps/web/.dev.vars.example`).

The outbox tuning variables (`OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_MS`) live in `[vars]` (not `.dev.vars`) and are documented in `apps/web/.env.example` — the schema is shared with the Node runtime via `packages/core/src/application/di/env.ts`.

## Deployment

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

## D1 migrations

SQL lands in `packages/core/src/adapters/d1/migrations/`, which the template ships empty — generate it with `pnpm db:generate:cf` from `packages/core/src/adapters/d1/schema.ts` before applying anything. (Bare `pnpm db:generate` targets the libSQL runtime, matching `pnpm db:migrate`.)

```bash
pnpm db:apply:local                    # apply to the local D1
pnpm db:apply:staging                  # apply to the staging D1
pnpm db:apply:production               # apply to the production D1
pnpm db:execute:local --file=...       # run an arbitrary SQL file locally
pnpm db:execute:staging --file=...     # run an arbitrary SQL file against staging
pnpm db:execute:production --file=...  # run an arbitrary SQL file against production
```

`pnpm db:migrate:cf` is an alias of `db:apply:local` for parity with the Node runtime's `pnpm db:migrate`.

## Queues

Two queues per stage:

- `events` — the main event stream produced by the relay and consumed by the consumer Worker.
- `events-dlq` — receives messages that the consumer's `1 + max_retries` budget could not deliver.

Queue parameters (visibility timeout, `max_retries`, `max_batch_size`, `max_batch_timeout`) live in the `[[queues.consumers]]` blocks of the per-stage `wrangler.<stage>.toml`. Adjust them per stage and re-deploy the consumer / DLQ Workers to pick up the new settings.

## Cron triggers

Two cron triggers ship in `wrangler.<stage>.toml`:

| Worker  | Schedule       | Purpose                                                              |
| ------- | -------------- | -------------------------------------------------------------------- |
| Relay   | every 5 min    | Safety-net publish loop — kicks in when the Service Binding fails.   |
| Pruner  | daily          | Deletes processed (and not-quarantined) outbox rows beyond retention. |

## Retry budget

A message reaches the DLQ only after **both** retry budgets are exhausted:

| Budget                        | Default | Source                                                   |
| ----------------------------- | ------- | -------------------------------------------------------- |
| Relay publish attempts        | 2       | `DEFAULT_MAX_ATTEMPTS` / `OUTBOX_MAX_ATTEMPTS` var       |
| Consumer subscriber attempts  | 4       | `1 + max_retries` from the `[[queues.consumers]]` block   |

The user-visible attempt count is the **product** of those numbers (max 8 by default), so adjust them together when tuning. Once the relay budget is exhausted on a row, `processOutboxEvents` stamps `failed_at`, and the row stays out of the queue until manually re-driven.

## D1-specific behaviour and the libSQL diff

The SQLite schema and SQL are shared verbatim across runtimes — both adapters consume `packages/core/src/adapters/d1/schema.ts` (libSQL re-exports it). What differs:

| Concern                     | D1                                                      | libSQL                                                          |
| --------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Transactional UoW           | `db.batch(stmts)` — pre-collected `PendingBatch`        | `client.transaction("write", fn)` — interactive transaction     |
| Error mapping               | Driver errors are parsed from message strings           | `LibsqlError.code` is a structured enum — more robust matching  |
| Relay trigger               | `ServiceBindingRelayTrigger` (cross-Worker `fetch`)     | `InProcessRelayTrigger` (`setImmediate` in the same process)    |
| Queue                       | Cloudflare Queues, durable, cross-region                | `InMemoryQueueDispatcher`, in-process only                      |
| Cron                        | Cloudflare Cron Triggers                                | `setInterval` inside the runner                                 |
| OCC `CHECK` constraints     | Shared — works identically                              | Shared — works identically                                      |
| `RETURNING` clauses         | Supported                                               | Supported (fuller coverage than D1, but kept to the shared subset) |

D1 cannot run an interactive transaction inside a Worker invocation: the only atomic primitive is `db.batch`, which is why the UoW pre-collects statements into a `PendingBatch`. libSQL exposes an interactive `transaction("write", fn)` API, so its UoW executes the same statements eagerly. Both produce the same observable semantics — including OCC failures, FK enforcement, and the at-least-once outbox dispatch — at the application layer.
