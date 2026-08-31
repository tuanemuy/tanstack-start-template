# Runtime: GCP (Cloud Run + Turso + Pub/Sub)

Production runtime for Google Cloud. The HTTP request path, the outbox relay, the Pub/Sub consumer, and the dead-letter sink all run as separate Cloud Run services from the same container image; `WORKER_ROLE` picks the role at start time. Turso (libSQL remote) is the database, so `packages/core/src/adapters/libsql/` is reused unchanged from the Node runtime.

See [`runtime_node.md`](./runtime_node.md) for the local-development single-process variant, [`runtime_cloudflare.md`](./runtime_cloudflare.md) for the Workers runtime, and the [GCP plan](./plan_runtime_gcp.md) for the design rationale.

## Table of contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Build and image](#build-and-image)
- [Roles and dispatch](#roles-and-dispatch)
- [Relay trigger model](#relay-trigger-model)
- [Pub/Sub envelope](#pubsub-envelope)
- [Migrations](#migrations)
- [Secrets](#secrets)
- [Local development](#local-development)
- [Infrastructure (Terraform)](#infrastructure-terraform)
- [Known limitations](#known-limitations)

## Quick start

```bash
# 1. Bootstrap Turso outside of GCP.
turso db create my-app
turso db show my-app --url            # libsql://...
turso db tokens create my-app         # paste into apps/web/.env.gcp

# 2. Apply migrations against the remote DB from a developer machine.
cp apps/web/.env.gcp.example apps/web/.env.gcp
# edit DATABASE_URL / DATABASE_AUTH_TOKEN / APP_URL
pnpm db:migrate:gcp

# 3. Build the container image.
docker build -f apps/web/Dockerfile.gcp -t gcr.io/$PROJECT/server:latest .
docker push gcr.io/$PROJECT/server:latest

# 4. Provision the rest with Terraform — three-stage apply
#    (see infra/gcp/example/README.md for full flags).
cd infra/gcp/example
( cd base     && terraform init && terraform apply -var "project_id=$PROJECT" \
    -var "turso_auth_token=$TURSO_AUTH_TOKEN" )
( cd services && terraform init && terraform apply -var "project_id=$PROJECT" \
    -var "image=gcr.io/$PROJECT/server:latest" \
    -var "turso_database_url=libsql://..." -var "app_url=https://app.example.com" )
( cd wiring   && terraform init && terraform apply -var "project_id=$PROJECT" )
```

## Environment variables

On Cloud Run the env vars come from `--set-env-vars` / Secret Manager bindings / the Terraform module. The schema is validated at boot in `packages/core/src/application/di/serverGcp.ts`.

For local container runs, pass `--env-file=apps/web/.env.gcp` to `docker run` (or invoke the launcher directly with Node's built-in `node --env-file=apps/web/.env.gcp apps/web/scripts/listen.gcp.mjs`). The launcher itself is plain ESM JS and does not load `.env` files — keeping dev-only loaders out of the production image is intentional.

| Variable                          | Required for                | Default | Purpose                                                                                       |
| --------------------------------- | --------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | all roles                   | —       | libSQL URL (`libsql://...` for Turso).                                                        |
| `DATABASE_AUTH_TOKEN`             | all roles                   | —       | Turso bearer token. Prefer Secret Manager via `DATABASE_AUTH_TOKEN_SECRET_NAME`.              |
| `APP_URL`                         | all roles                   | —       | Public origin for absolute-URL building.                                                      |
| `WORKER_ROLE`                     | all roles                   | `app`   | One of `app`, `relay`, `consumer`, `dlq`. Drives the role dispatch in `server.gcp.ts`.        |
| `GCP_PROJECT_ID`                  | `relay`                     | (auto)  | Pub/Sub client project. Defaults to the Cloud Run metadata server.                            |
| `EVENTS_TOPIC`                    | `relay`                     | —       | Pub/Sub topic the relay publishes to (no `projects/...` prefix).                              |
| `RELAY_URL`                       | `app`                       | —       | Relay Cloud Run URL. Used by the `app` service after each UoW commit. The relay self-chain is disabled on GCP (see [Relay trigger model](#relay-trigger-model)); leaving `RELAY_URL` unset on the relay role is intentional. |
| `DATABASE_AUTH_TOKEN_SECRET_NAME` | optional                    | —       | Secret Manager version name. When set, the boot loader fetches it into `DATABASE_AUTH_TOKEN`. |
| `OUTBOX_BATCH_SIZE`               | optional                    | `100`   | Max outbox rows claimed per relay tick.                                                       |
| `OUTBOX_LEASE_MS`                 | optional                    | `300000`| Lease window before a stuck claim becomes reclaimable.                                        |
| `OUTBOX_MAX_ATTEMPTS`             | optional                    | `2`     | Per-event publish attempts before quarantine.                                                 |
| `OUTBOX_RETENTION_MS`             | optional                    | `604800000` | Retention before processed outbox rows are pruned.                                        |
| `PORT` / `HOSTNAME`               | optional                    | `8080` / `0.0.0.0` | Cloud Run injects `PORT=8080`; override only for local testing.                  |

## Build and image

The same image runs all five Cloud Run services:

```bash
pnpm build:gcp                            # vite build → apps/web/dist/server/server.gcp.js
docker build -f apps/web/Dockerfile.gcp -t ... .   # multi-stage; runtime layer keeps only prod deps
```

Cloud Run runs `node apps/web/scripts/listen.gcp.mjs` as `CMD`. The launcher imports the bundled `apps/web/dist/server/server.gcp.js` `boot()`, which inspects `WORKER_ROLE` and returns the appropriate fetch handler. The launcher is plain ESM JavaScript so the runtime image needs neither `tsx` nor `dotenv`.

## Roles and dispatch

| Role       | Triggered by                                                | Endpoint            |
| ---------- | ----------------------------------------------------------- | ------------------- |
| `app`      | Public HTTPS                                                | `*` (TanStack Start) |
| `relay`    | Cloud Scheduler + authenticated POST from `app` / self      | `POST /`            |
| `consumer` | Pub/Sub push subscription (events topic)                    | `POST /`            |
| `pruner`   | Cloud Scheduler (daily)                                     | `POST /`            |
| `dlq`      | Pub/Sub push subscription (events-dlq topic)                | `POST /` (always 204) |

The pruner is a dedicated Cloud Run service, not a route on `app`. The app service carries an `allUsers` invoker, so any path it serves is public — granting the scheduler SA `roles/run.invoker` on top of that would not restrict anything. A separate service whose only invoker is the scheduler SA is the smallest layout under which Cloud Run IAM actually gates the daily tick.

## Relay trigger model

`CloudRunRelayTrigger` (`packages/core/src/adapters/gcp/cloudRunRelayTrigger.ts`) issues an authenticated `POST` to the relay service after a UoW commit. The OIDC ID token is minted via `google-auth-library` with the relay service URL as the audience; Cloud Run verifies the token and the `roles/run.invoker` binding.

The fetch is fire-and-forget — the request handler returns the HTTP response without awaiting the kick. A 5-minute Cloud Scheduler cron acts as the safety net.

On GCP the saturation self-chain is **disabled by design**: the reference Terraform layout avoids the Cloud Run self-reference cycle by not injecting `RELAY_URL` into the relay role. When a tick saturates `maxIterations`, the relay returns without re-kicking itself and the next Scheduler tick (or the next post-UoW kick from `app`) picks up the remaining outbox rows. At-least-once delivery and idempotent consumers are unaffected — only worst-case backlog drain latency is. See `infra/gcp/example/README.md` for the trade-off and how to re-enable the self-chain if you need it.

## Pub/Sub envelope

Pub/Sub push subscriptions wrap each message in this envelope:

```json
{
  "message": {
    "data": "<base64-encoded JSON DomainEvent>",
    "messageId": "...",
    "publishTime": "...",
    "attributes": {}
  },
  "subscription": "..."
}
```

`apps/web/app/worker/gcp/consumer.ts` decodes the envelope, runs the same `parseEvent` round-trip the AWS consumer uses (so `occurredAt` is rehydrated to a `Date` and value-object construction re-runs), then writes the idempotency marker. A 204 acks, a 5xx nacks and Pub/Sub redrives — once the dead-letter policy threshold is exceeded the message lands on `events-dlq` and the `dlq` service logs it.

## Migrations

Turso is SQLite-compatible, so the libSQL Drizzle migration set works as-is:

```bash
pnpm db:generate        # drizzle-kit generate → packages/core/src/adapters/libsql/migrations/
pnpm db:migrate:gcp     # tsx apps/web/scripts/migrate.gcp.ts against DATABASE_URL/DATABASE_AUTH_TOKEN
```

The migrator reads `process.env` only; the `db:migrate:gcp` script injects `apps/web/.env.gcp` via `tsx --env-file-if-exists=.env.gcp` (variables already present in the environment win). `__drizzle_migrations` is created in the Turso DB so reruns are idempotent. Run this from your dev machine or as a Cloud Build step before each release.

## Secrets

`DATABASE_AUTH_TOKEN` is the only secret the runtime needs. Two options:

1. **Cloud Run-native mount** (preferred) — declare a Secret Manager binding in Terraform with `value_source { secret_key_ref { ... } }` and let Cloud Run inject the value as a plain env var. The boot loader sees `DATABASE_AUTH_TOKEN` already populated and skips the SDK call.
2. **Explicit loader** — set `DATABASE_AUTH_TOKEN_SECRET_NAME=projects/.../secrets/.../versions/latest` and the boot loader (`packages/core/src/adapters/gcp/secretsLoader.ts`) fetches the value at cold start. Use this when the deployment surface (e.g. an ad-hoc `gcloud run deploy`) cannot declare the binding.

The Turso URL (`DATABASE_URL`) is treated as low-sensitivity and lives as a plain env var; rotate the token, not the URL.

## Local development

The GCP runtime is not meant to be run end-to-end locally — Pub/Sub push delivery in particular needs an external HTTP target the emulator can reach. Two reasonable strategies:

- **Default: keep using the Node runtime for local dev.** `pnpm dev` (Node, single-process) covers everything the GCP runtime does. The container shape and Pub/Sub plumbing only matter at staging time.
- **Container parity loop:** `docker build -f apps/web/Dockerfile.gcp -t local/server . && docker run -p 8080:8080 --env-file apps/web/.env.gcp local/server` boots the app role against the remote Turso DB. The relay / consumer roles can be exercised by `curl`-ing them with a mock Pub/Sub envelope.

For the Pub/Sub emulator, run `gcloud beta emulators pubsub start --host-port=0.0.0.0:8085` and set `PUBSUB_EMULATOR_HOST=localhost:8085` for the relay process; the consumer side still needs you to manually craft `POST /` calls.

## Infrastructure (Terraform)

`infra/gcp/example/` contains a **reference** Terraform layout — read its README before applying. It is split into three sibling root modules (`base/`, `services/`, `wiring/`) applied in order; the split exists so that Cloud Run URLs flow into Pub/Sub subscriptions and Scheduler jobs without an intra-stack reference cycle. Between them they create the five Cloud Run services, both Pub/Sub topics with subscriptions, the Cloud Scheduler jobs, Secret Manager entry, and the service-to-service IAM bindings.

It does **not** create:
- The container image (build + push separately)
- Turso (create with `turso db create` and pass the URL + token as inputs)
- Custom domains / load balancers
- Logging / monitoring policy

For staging vs production, instantiate the module twice with different `name_prefix` values in different workspaces, or wrap it in a top-level module that does the multiplexing.

## Known limitations

- **Cold start cost.** Cloud Run with `min-instances=0` pays a Node startup + libSQL connect on the first request after idle. Set `min_instance_count = 1` on the `app` service in production (the Terraform example does this).
- **No order guarantees.** Pub/Sub is at-least-once / unordered (we don't use ordering keys). Consumers must be idempotent.
- **Pub/Sub default dead-letter SA.** Pub/Sub's project-level service agent needs `roles/pubsub.publisher` on `events-dlq` to forward failed deliveries. The Terraform example does not grant this (it's project-state-dependent); add the binding manually or via a separate module the first time.
- **No bundled local emulator stack.** A full docker-compose with emulators is left as an opt-in (see [Local development](#local-development)).
