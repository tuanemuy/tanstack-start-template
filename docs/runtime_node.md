# Runtime: Node.js + libSQL (standalone)

Single-process runtime backed by an embedded libSQL file. No Docker, no Cloudflare account required. The full Outbox / domain-event lifecycle (relay → consumer → pruner) runs inside the same process as the HTTP server.

This is the default runtime: `pnpm dev` / `pnpm build` / `pnpm start` all alias to the `:node` variants. See [`runtime_cloudflare.md`](./runtime_cloudflare.md) for the Workers runtime.

## Table of contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [The libSQL data file](#the-libsql-data-file)
- [SQLite PRAGMAs applied at boot](#sqlite-pragmas-applied-at-boot)
- [Worker runner (relay / consumer / pruner)](#worker-runner-relay--consumer--pruner)
- [Migrations](#migrations)
- [Graceful shutdown](#graceful-shutdown)
- [Single-process operational constraints](#single-process-operational-constraints)
- [Logging and observability](#logging-and-observability)
- [Known limitations](#known-limitations)

## Quick start

```bash
pnpm install
cp .env.example .env       # edit if defaults are not appropriate
pnpm db:migrate            # creates ./data/ and applies migrations
pnpm dev                   # http://localhost:3000
```

For a production build:

```bash
pnpm build                 # vite build with the Node target (vite.config.node.ts)
pnpm start                 # tsx apps/web/scripts/listen.node.ts — boots @hono/node-server
```

The flow:

1. `vite build --config vite.config.node.ts` writes a fetch-handler bundle to `apps/web/dist/server/server.node.js`.
2. `apps/web/scripts/listen.node.ts` loads `dotenv`, dynamically imports the bundle, calls its `boot()` to construct the libSQL client + DI container + worker runner, then registers the handler with `@hono/node-server`.
3. SIGTERM / SIGINT triggers the shutdown sequence described below.

## Environment variables

`apps/web/scripts/listen.node.ts` and `apps/web/scripts/migrate.node.ts` both load `.env` via `dotenv/config` before importing the rest of the app. Copy `.env.example` to `.env` and edit; the schema is validated at boot in `packages/core/src/application/di/serverNode.ts`.

| Variable                  | Required | Default                  | Purpose                                                                                              |
| ------------------------- | -------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | yes      | `file:./data/app.db`     | libSQL URL. `file:` opens an embedded SQLite file; `:memory:` is ephemeral; `libsql://` is remote.   |
| `APP_URL`                 | yes      | `http://localhost:3000`  | Public origin used to build absolute URLs (canonical / OG image / OAuth callbacks).                  |
| `PORT`                    | no       | `3000`                   | HTTP listener port.                                                                                  |
| `HOSTNAME`                | no       | `0.0.0.0`                | HTTP listener bind address.                                                                          |
| `DATABASE_AUTH_TOKEN`     | no       | (unset)                  | Bearer token for remote libSQL / Turso. Leave unset for local files.                                 |
| `DATABASE_ENCRYPTION_KEY` | no       | (unset)                  | Encryption key for encrypted libSQL databases. Leave unset for plaintext.                            |
| `OUTBOX_BATCH_SIZE`       | no       | `25`                     | Max outbox rows claimed per relay tick.                                                              |
| `OUTBOX_LEASE_MS`         | no       | `30000`                  | Lease window (ms) before a stuck claim becomes reclaimable.                                          |
| `OUTBOX_MAX_ATTEMPTS`     | no       | `3`                      | Per-event max attempts before quarantine (`failed_at` stamp).                                        |
| `OUTBOX_RETENTION_MS`     | no       | `604800000` (7 days)     | Retention window before processed outbox rows are pruned.                                            |

The outbox tuning variables are shared with the Cloudflare runtime; the schema is declared once in `packages/core/src/application/di/env.ts` and consumed by both `serverNode.ts` and the wrangler `[vars]` readers.

## The libSQL data file

`DATABASE_URL=file:./data/app.db` (the default) produces three files at runtime:

```
data/
├─ app.db        # main database file
├─ app.db-wal    # write-ahead log (created when PRAGMA journal_mode = WAL is on)
└─ app.db-shm    # shared memory file used by WAL
```

`./data/` is gitignored, and `apps/web/scripts/migrate.node.ts` + `apps/web/app/server.node.ts` both `mkdir -p` the parent directory at boot — libSQL's embedded driver does not create it automatically.

### Backup

The database is plain SQLite. Two options:

- **Cold copy** while the process is stopped:

  ```bash
  pnpm stop                          # or kill the process; wait for shutdown
  cp data/app.db data/backup-$(date +%Y%m%d).db
  ```

- **Online backup** while the process is running, via the SQLite CLI's `.backup` command:

  ```bash
  sqlite3 data/app.db ".backup data/backup-$(date +%Y%m%d).db"
  ```

  `.backup` is concurrency-safe under WAL — readers and writers continue uninterrupted.

The `*-wal` / `*-shm` sidecar files do **not** need to be copied; SQLite reconstructs them from the main file on next open. Restore by stopping the process, replacing `data/app.db` with the backup, and starting again.

## SQLite PRAGMAs applied at boot

`packages/core/src/adapters/libsql/client.ts#applyPragmas` runs three statements after the client is constructed (unless `wal: false` is passed for `:memory:` / read-only test databases):

| PRAGMA                  | Why                                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journal_mode = WAL`    | Readers do not block the single writer. Matches the throughput model the deferred-batch UoW assumes.                                                                                                      |
| `foreign_keys = ON`     | SQLite ships with FK enforcement off; D1 has it on by default. Without this PRAGMA the libSQL adapter would silently diverge for any future FK relation.                                                  |
| `busy_timeout = 5000`   | Gives a 5-second wait before a contended write surfaces as `SQLITE_BUSY`. The UoW does not retry on `SQLITE_BUSY`, so this buffer is the only protection against transient contention from cron sweeps.   |

## Worker runner (relay / consumer / pruner)

`apps/web/app/worker/node/runner.ts#createNodeWorkerRunner` is the same-process orchestrator for the four roles that ship as separate Workers on Cloudflare.

| Role     | Cloudflare                              | Node                                                                                                              |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Relay    | 5-minute cron + `RELAY` Service Binding | 60-second `setInterval` fallback + `InProcessRelayTrigger.kick()` from the request-path UoW (`setImmediate` fan)  |
| Consumer | Queue subscriber                        | `InMemoryQueueDispatcher` — relay hands a decoded batch to the dispatcher, which invokes the consumer handler     |
| Pruner   | Daily cron                              | 24-hour `setInterval`                                                                                             |
| DLQ      | Dedicated Worker over `events-dlq`      | `processOutboxEvents` already logs `[outbox] quarantining event …` when `failed_at` is stamped — no separate sweep |

`runner.start()`:

- Fires an immediate relay tick so a freshly-started process drains any backlog from a previous crash without waiting a full interval.
- Registers the two intervals and `process.on("SIGTERM" | "SIGINT", …)` handlers.
- Returns synchronously; the timers `unref` so short-lived scripts and tests can exit naturally.

Concurrent kicks are collapsed: the periodic fallback and request-path kicks share one in-flight slot, so the same outbox row is never claimed twice in the same tick. Lease semantics still apply across process restarts — a crashed worker's claim is reclaimable once `OUTBOX_LEASE_MS` lapses.

### Consumer handler

`consumerHandler` is a required dependency on `createNodeWorkerRunner` so wiring is explicit at the type level. `apps/web/app/server.node.ts` passes an inline `async () => {}` as the template default — replace it with your application-specific subscriber. Idempotency is enforced by the dispatcher before the handler runs, so handlers stay idempotent without per-handler bookkeeping.

## Migrations

The canonical schema lives at `packages/core/src/adapters/d1/schema.ts`; `packages/core/src/adapters/libsql/schema.ts` re-exports it so both runtimes share an identical type-level surface.

```bash
pnpm db:generate           # alias of db:generate:cf
pnpm db:generate:cf        # drizzle-kit generate → packages/core/src/adapters/d1/migrations/
pnpm db:generate:node      # drizzle-kit generate → packages/core/src/adapters/libsql/migrations/ (mirror)
pnpm db:migrate            # alias of db:migrate:node
pnpm db:migrate:node       # tsx apps/web/scripts/migrate.node.ts — applies libSQL migrations
```

Workflow:

1. Edit `packages/core/src/adapters/d1/schema.ts`.
2. `pnpm db:generate:cf` to author the SQL (this is the source of truth).
3. `pnpm db:generate:node` to mirror it under `packages/core/src/adapters/libsql/migrations/`.
4. `pnpm db:migrate` to apply against the local libSQL file.

Drizzle's programmatic migrator writes its bookkeeping into the `__drizzle_migrations` table inside the database, so re-running `pnpm db:migrate` is idempotent.

## Graceful shutdown

`apps/web/scripts/listen.node.ts` and `apps/web/app/server.node.ts` both register SIGTERM / SIGINT handlers. The shutdown sequence:

1. `@hono/node-server` stops accepting new HTTP connections.
2. `runner.stop()`:
   1. Clears the relay / prune `setInterval`s and removes signal handlers.
   2. `relayTrigger.stop()` rejects further `kick()` calls.
   3. Awaits all tracked in-flight relay / prune ticks via the `pendingSweeps` set.
   4. Calls the cleanup hook supplied at construction time, which `client.close()`s the libSQL handle.
3. `process.exit(0)`.

The shutdown promise is memoised — calling `stop()` repeatedly (e.g. from a signal handler and again from a test teardown) is safe.

### `*.db-wal` / `*.db-shm` after shutdown

These sidecar files may remain on disk even after a clean shutdown; SQLite reclaims them lazily and reuses them on next open. This is normal — do not delete them while the process is running.

## Single-process operational constraints

The Node runtime is **single-writer, single-process**. libSQL's embedded driver does not coordinate across OS processes (multiple processes opening the same `file:` URL race against each other on the WAL), and the worker runner assumes one in-flight relay loop at a time.

Implications:

- Run exactly one instance of `pnpm start` against a given `data/app.db` path.
- Horizontal scaling (multiple Node processes behind a load balancer sharing one DB file) is **not supported** in this template. Promote to the Cloudflare runtime, or front the libSQL data with a Turso remote URL (see *Known limitations* below).
- Vertical scaling (a single beefier machine) works fine — WAL allows many concurrent readers against the single writer.

## Logging and observability

The application uses the `ConsoleLogger` port (`packages/core/src/application/ports/logger.ts`) — every log line is `console.log` / `console.error` formatted as JSON-ish objects. On Cloudflare this is picked up by `wrangler tail` / Logpush; on Node the lines go straight to stdout / stderr and can be piped into any aggregator (journald, vector, etc).

Structured logging via `pino` or similar is a deliberate non-goal of the current template (the Cloudflare runtime constrains the choices). It is on the open-issues list in `plan.md`.

## Known limitations

- **Single-process only.** No clustering / multi-process worker fanout. If you need that, deploy the Cloudflare runtime.
- **Turso remote mode is not exercised.** The libSQL client can in principle open a `libsql://` URL with `DATABASE_AUTH_TOKEN`, and the env schema accepts it, but the template does not ship operational guidance for remote mode (replication, embedded replica, sync strategy). Treat it as experimental.
- **No application-level encryption-at-rest helper.** `DATABASE_ENCRYPTION_KEY` is passed straight to the driver; key management is your responsibility.
- **No built-in DLQ surface.** Quarantined outbox rows (`failed_at IS NOT NULL`) are visible only through the log line `[outbox] quarantining event …` and direct SQL inspection. The CF runtime has a dedicated DLQ Worker; the Node runtime intentionally does not duplicate it.
