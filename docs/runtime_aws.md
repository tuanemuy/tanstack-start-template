# Runtime: AWS Lambda + Turso + SQS

Fully-serverless runtime. The request path runs as a Lambda fronted by API Gateway HTTP API (and CloudFront for static assets); outbox publish, queue consumption, daily pruning, and DLQ surfacing each ship as a sibling Lambda driven by EventBridge Scheduler, SQS event source mappings, and `lambda:Invoke` (async).

The database is **Turso** (libSQL remote). The shared `packages/core/src/adapters/libsql/` adapter is reused unchanged — only the entry points and DI wiring differ from the Node runtime.

See [`runtime_node.md`](./runtime_node.md) for the standalone Node runtime and [`runtime_cloudflare.md`](./runtime_cloudflare.md) for the Cloudflare Workers runtime.

## Table of contents

- [Quick start](#quick-start)
- [Function matrix](#function-matrix)
- [Build pipeline](#build-pipeline)
- [Environment variables](#environment-variables)
- [Turso setup](#turso-setup)
- [Deployment](#deployment)
- [Migrations](#migrations)
- [SQS event source mapping](#sqs-event-source-mapping)
- [Cron (EventBridge Scheduler)](#cron-eventbridge-scheduler)
- [Retry budget](#retry-budget)
- [Secrets](#secrets)
- [Turso-specific notes](#turso-specific-notes)

## Quick start

```bash
pnpm install
cp apps/web/.env.aws.example apps/web/.env.aws
# fill in DATABASE_URL (libsql://...), DATABASE_AUTH_TOKEN
pnpm db:generate                    # generate SQL from the Drizzle schema
pnpm db:migrate:aws                 # apply migrations to the Turso primary
pnpm deploy:aws:synth               # cdk synth — sanity-check the stack
pnpm deploy:aws:staging             # cdk deploy AppStack-staging
```

Local dev does **not** simulate Lambda. Use `pnpm dev` (the Node runtime) for the inner loop; AWS-specific behaviour (SQS batching, async invoke, CloudFront cache) is verified in `staging`.

## Function matrix

The stack ships five Lambdas per stage. Three of them (`relay`, `consumer`, `pruner`, `dlq`) share `apps/web/app/worker/aws/handlers.ts`; entry-point files under `apps/web/app/worker/aws/` are thin role-typed wrappers.

| Lambda     | Trigger                                                  | Responsibility                                              |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| `app`      | API Gateway HTTP API (`ANY /` + `ANY /{proxy+}`)         | TanStack Start HTTP request handling                        |
| `relay`    | EventBridge Scheduler (5 min) + async `lambda:Invoke`    | Publish outbox rows to SQS; self-chain on saturated batches |
| `consumer` | SQS event source mapping (`events` queue)                | Idempotency check + business projection / notification      |
| `pruner`   | EventBridge Scheduler (daily, 03:00 UTC)                 | Delete processed outbox rows beyond retention               |
| `dlq`      | SQS event source mapping (`events-dlq` queue)            | Log quarantined messages — always acks                      |

Trigger model: the request-path Lambda kicks `relay` via async `Invoke` right after a UoW commit, so newly-persisted events publish without waiting on cron. The EventBridge 5-minute cron is the safety-net. Inside a tick, `processOutboxEvents` drains up to `maxIterations` consecutive batches; if the tick exits saturated (every iteration drained a full batch), it self-invokes the relay function so a backlog drains in one chain rather than 5-minute slices.

## Build pipeline

`app` and the four workers are built differently:

| Lambda       | Bundler           | Output                                                                       |
| ------------ | ----------------- | ---------------------------------------------------------------------------- |
| `app`        | Vite (`pnpm build:aws`) | `apps/web/dist/server/server.aws.js` — self-contained (`ssr.noExternal: true`); CDK `Code.fromAsset("apps/web/dist/server")` |
| `relay` / `consumer` / `pruner` / `dlq` | CDK `NodejsFunction` (esbuild) | Bundled by CDK at synth time from `apps/web/app/worker/aws/<role>.ts` |
| Client assets | Vite (`pnpm build:aws`) | `apps/web/dist/client/assets/*.<hash>.{js,css}` — uploaded to S3 by `BucketDeployment` |

`@aws-sdk/*` is externalised in both pipelines: the Lambda Node.js 22 runtime ships AWS SDK v3 in `/var/runtime/node_modules`, so bundling it would only bloat the artifact.

## Environment variables

The schema is declared in `packages/core/src/application/di/serverAws.ts` and validated at cold start. Outbox tuning vars are shared with the Node and Cloudflare runtimes via `packages/core/src/application/di/env.ts`.

| Variable                          | Required | Purpose                                                                              |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL`                    | yes      | Turso URL (`libsql://...` in production).                                            |
| `DATABASE_AUTH_TOKEN`             | yes\*    | Turso bearer token. \*Required at runtime, but populated from Secrets Manager when `DATABASE_AUTH_TOKEN_SECRET_ARN` is set. |
| `APP_URL`                         | yes      | Public origin. After the first deploy, set to the CloudFront `DistributionUrl`.      |
| `EVENTS_QUEUE_URL`                | relay    | SQS queue URL the relay publishes to. Provided by CDK as a Lambda env var.           |
| `RELAY_FUNCTION_NAME`             | relay/app| Relay Lambda function name for async self-invoke and request-path kick.              |
| `DATABASE_AUTH_TOKEN_SECRET_ARN`  | no       | Secrets Manager ARN. When set, the boot loader fetches the secret and populates `DATABASE_AUTH_TOKEN` before the libSQL client is constructed. |
| `AWS_REGION`                      | no       | Set by Lambda automatically. Explicit only for local `migrate.aws` invocations.      |
| `OUTBOX_BATCH_SIZE`               | no       | Max outbox rows claimed per relay tick. Default `25`.                                |
| `OUTBOX_LEASE_MS`                 | no       | Lease window (ms) before a stuck claim becomes reclaimable. Default `30000`.         |
| `OUTBOX_MAX_ATTEMPTS`             | no       | Per-event max relay attempts before quarantine. Default `3`.                         |
| `OUTBOX_RETENTION_MS`             | no       | Retention window before processed rows are pruned. Default `604800000` (7 days).     |

`apps/web/.env.aws` is gitignored and used only by local scripts (`pnpm db:migrate:aws`). Deployed Lambdas read their env from CDK.

## Turso setup

Turso is not managed by CDK — create the database with the `turso` CLI, store the auth token in Secrets Manager, and pass URL + secret ARN as stack props.

```bash
# 1. Create the database (per stage)
turso db create tanstack-start-template-staging --location aws-us-east-1
turso db create tanstack-start-template-production --location aws-us-east-1

# 2. Mint per-stage auth tokens
turso db tokens create tanstack-start-template-staging
turso db tokens create tanstack-start-template-production

# 3. Store each token as a Secrets Manager secret (plain string, not JSON)
aws secretsmanager create-secret \
  --name tanstack-start-template/staging/turso-auth-token \
  --secret-string "<paste token>"

# 4. Record the URL + secret ARN for the CDK env-var contract below.
turso db show tanstack-start-template-staging --url
```

**Match the Turso primary region to the Lambda region.** A cross-region hop on every write adds ~50 ms to each statement, which is multiplied by the per-statement RPC nature of libSQL remote.

## Deployment

CDK is invoked from `infra/aws/`. The `infra/aws/bin/app.ts` entry reads stage-keyed env vars (`TURSO_URL_STAGING`, `TURSO_AUTH_TOKEN_SECRET_ARN_STAGING`, `APP_URL_STAGING`, and the `_PRODUCTION` equivalents) and instantiates one `AppStack-<stage>` per configured stage. Stages without env vars are silently skipped, so partial configurations stay synth-able.

```bash
TURSO_URL_STAGING=libsql://... \
TURSO_AUTH_TOKEN_SECRET_ARN_STAGING=arn:aws:secretsmanager:... \
APP_URL_STAGING=https://staging.example.com \
pnpm deploy:aws:synth                # cdk synth
pnpm deploy:aws:diff                 # cdk diff
pnpm deploy:aws:staging              # cdk deploy AppStack-staging
pnpm deploy:aws:production           # cdk deploy AppStack-production
```

After the first deploy, read `DistributionUrl` from the stack outputs and feed it back as `APP_URL_<STAGE>` on subsequent deploys so the app builds canonical / OG URLs against the real origin.

The `app` Lambda picks up the freshly-built `apps/web/dist/server/server.aws.js` because every `deploy:aws:*` script runs `pnpm build:aws` first; client assets are deployed via the `BucketDeployment` construct in the same `cdk deploy` invocation.

## Migrations

```bash
pnpm db:generate              # drizzle-kit generate (alias of db:generate:node)
pnpm db:migrate:aws           # tsx apps/web/scripts/migrate.aws.ts — applies libSQL migrations to Turso
```

The migrator reads `process.env` only; the `db:migrate:aws` script injects `apps/web/.env.aws` via `tsx --env-file-if-exists=.env.aws` (variables already present in the environment win). Drizzle's `__drizzle_migrations` table tracks applied versions, so re-runs are idempotent. Run the migration from CI before each deploy that introduces schema changes.

## SQS event source mapping

Two queues per stage (`<stage>-events`, `<stage>-events-dlq`). The consumer event source mapping has `reportBatchItemFailures: true` so only failed messages are redriven within a batch.

| Setting                  | Value | Adjust at                                                               |
| ------------------------ | ----- | ----------------------------------------------------------------------- |
| `BatchSize`              | 10    | `appStack.ts` → `new SqsEventSource(eventsQueue, { batchSize })`        |
| `MaximumBatchingWindowInSeconds` | 1   | `appStack.ts` → `maxBatchingWindow`                                     |
| `VisibilityTimeout`      | 60s   | `appStack.ts` → `new Queue(this, "EventsQueue", { visibilityTimeout })` |
| `maxReceiveCount` (DLQ)  | 5     | `appStack.ts` → `deadLetterQueue: { ..., maxReceiveCount }`             |
| Retention                | 14d (DLQ) / SQS default (main) | `appStack.ts` → `Queue` `retentionPeriod`             |

The `dlq` Lambda intentionally has **no** `reportBatchItemFailures`: the DLQ has no further dead-letter target, so a failure loop would burn invocations on messages no human will see.

## Cron (EventBridge Scheduler)

Two schedules ship in `appStack.ts`:

| Schedule              | Target            | Purpose                                                          |
| --------------------- | ----------------- | ---------------------------------------------------------------- |
| `rate(5 minutes)`     | `relay` Lambda    | Safety-net relay tick — covers missed async-invoke kicks.        |
| `cron(0 3 * * ? *)`   | `pruner` Lambda   | Daily outbox prune at 03:00 UTC.                                 |

The relay also self-chains via `lambda:Invoke` when a tick drains a saturated batch, so the 5-minute cron is the floor, not the only path.

## Retry budget

A message reaches the DLQ only after **both** retry budgets are exhausted:

| Budget                        | Default | Source                                                     |
| ----------------------------- | ------- | ---------------------------------------------------------- |
| Relay publish attempts        | 3       | `DEFAULT_MAX_ATTEMPTS` / `OUTBOX_MAX_ATTEMPTS` env var     |
| Consumer redrive attempts     | 5       | `deadLetterQueue.maxReceiveCount` in `appStack.ts`         |

The user-visible attempt count is the **product** of those numbers (15 by default), so adjust them together when tuning. Once the relay budget is exhausted on a row, `processOutboxEvents` stamps `failed_at`, and the row stays out of SQS until manually re-driven.

## Secrets

| Concern                       | Default storage                              | Notes                                                                                       |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_AUTH_TOKEN`         | Secrets Manager (referenced by ARN env var)  | The boot loader (`secretsLoader.ts`) populates `process.env.DATABASE_AUTH_TOKEN` cold-start. |
| `DATABASE_URL`                | Lambda env var (plaintext)                   | Low sensitivity — Turso URLs are non-secret without the matching token.                     |
| `APP_URL`                     | Lambda env var (plaintext)                   | Public origin.                                                                              |
| Application secrets (`JWT_*`) | Secrets Manager (add bindings to `serverAws.ts`) | Extend `loadSecretsIntoEnv` bindings in `apps/web/app/server.aws.ts` and worker handlers.            |

Rotation: a non-empty existing env value wins over the secret, so local overrides (e.g. `.env.aws` for migrations) keep working without unsetting the ARN. To force a refresh after rotation in a long-lived dev shell, unset the env var.

The consumer / DLQ Lambdas can run with a read-only Turso token if you prefer least-privilege; mint a separate secret and split the `tursoAuthSecretArn` prop. The shipped CDK uses one full-access secret for simplicity.

## Turso-specific notes

- **Connection model**: libSQL remote is HTTP / WebSocket. There's no pooled-TCP cold start, so a freshly-thawed Lambda container does not pay a Postgres-style warmup penalty.
- **Per-statement RPCs**: each statement inside `client.transaction("write", fn)` is one round trip. Keep UoW transactions small.
- **Embedded replicas are not used**: Lambda's `/tmp` is instance-local and ephemeral, so the sync cost does not amortise. Run in pure remote mode.
- **CAS lease**: the libSQL outbox lease + CAS sweep (same code path as the Node runtime) handles concurrent relay Lambdas correctly. `SELECT ... FOR UPDATE SKIP LOCKED` (Postgres) is intentionally unavailable.
- **SQL parity**: the schema, migrations, and SQL queries are byte-identical to the Cloudflare D1 runtime — `adapters/d1/schema.ts` is the single source of truth and `adapters/libsql/schema.ts` re-exports it.
