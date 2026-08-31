# Runtime: Cloudflare Workers (Durable Objects + Queues)

Durable-Object variant of the Cloudflare runtime. A SQLite-backed Durable Object (`TodoStateObject`) owns the todo aggregate **and** its outbox in the same private SQLite database; the DO's Alarm relays the outbox to a Queue. Compared to the [D1 topology](./runtime_cloudflare.md), three infrastructure pieces disappear — the relay Worker, its safety-net cron, and the pruner Worker — because the platform's guaranteed, auto-retried Alarm plays all of those roles.

The inward layers are untouched: the same usecases, the same `processOutboxEvents` drain policy, the same consumer/DLQ handlers pattern. What swaps is the adapter group (`packages/core/src/adapters/do/`) and the entry wiring (`serverCloudflareDo.ts`).

## Table of contents

- [Quick start](#quick-start)
- [Worker matrix](#worker-matrix)
- [How a unit of work commits](#how-a-unit-of-work-commits)
- [Alarm relay model](#alarm-relay-model)
- [RPC protocol and error boundary](#rpc-protocol-and-error-boundary)
- [Schema and migrations](#schema-and-migrations)
- [Scaling to multiple tenants](#scaling-to-multiple-tenants)
- [Deployment](#deployment)
- [Differences vs the D1 topology](#differences-vs-the-d1-topology)

## Quick start

```bash
pnpm install
pnpm --filter @repo/web dev:do        # vite dev backed by workerd, wrangler.do.toml
```

No database setup: there is no D1 database and no migration step. The DO applies its schema idempotently in its constructor (`applyDoSchema`), so the first request creates everything.

## Worker matrix

Two Worker roles instead of five, plus the Durable Object class hosted by the app Worker:

| Role        | Responsibility                                                          | Wrangler env     | Trigger                          |
| ----------- | ----------------------------------------------------------------------- | ---------------- | -------------------------------- |
| App (fetch) | TanStack Start HTTP + hosts `TodoStateObject` (state, relay, idempotency) | _(top level)_    | HTTP / DO Alarm                  |
| Consumer    | Consume the Queue (projections / notifications)                          | `--env consumer` | Queue consumer (`do-events`)     |
| DLQ         | Surface events that exhausted the consumer's retry budget                | `--env dlq`      | Queue consumer (`do-events-dlq`) |

There is deliberately **no relay Worker, no relay cron, and no pruner Worker**. The DO's `alarm()` is the relay and the pruner; commit arms it, and the platform retries a failed `alarm()` with backoff, so no external safety net is required. The trigger invariant is: *the alarm is armed whenever a pending outbox row exists* — `commit` arms it when it inserts events, each tick re-arms while rows remain, and `kickRelay()` (an RPC on the DO) is the operator escape hatch after manual row edits.

## How a unit of work commits

`DoUnitOfWorkProvider` (request Worker) buffers writes as plain commands and reads through the DO stub immediately — the same deferred-write/read-through split as the D1 adapter, with a different flush:

1. The usecase callback runs in the request Worker. `findById` / `findPage` RPC to the DO; `insert` / `save` / `delete` push `TodoWriteCommand`s onto a local buffer; `collectEvents` mints `EventId`s and buffers events.
2. One `commit` RPC ships the buffer. The DO applies every command plus the outbox inserts inside a single `transactionSync` — a **real interactive transaction**, so there is no `_occ_guard` CHECK trick.
3. OCC is a per-statement conditional write (`UPDATE … WHERE id = ? AND version = ? RETURNING 1`). A zero-row result aborts the transaction and the conflict comes back **as data** naming the exact losing command; the provider rethrows it as `ConflictError("OPTIMISTIC_LOCK_FAILURE")`. Misattribution across multiple OCC writes is structurally impossible here.
4. If the commit inserted events, the DO arms its alarm before the RPC returns. There is no relay trigger port in this runtime.

Read-your-write within one UoW is unsupported by design, matching every other adapter in the template.

## Alarm relay model

`alarm()` runs `runOutboxAlarmTick` (`packages/core/src/adapters/do/alarm.ts`): relay → prune → re-arm.

- **Relay** is the shared `processOutboxEvents` worker over `DoSqliteOutboxRepository` — same batching, backoff, quarantine, and lease semantics as every other runtime. The lease is not fighting concurrent workers (a DO is single-threaded); it covers an alarm invocation that crashes between claim and finalize, whose rows become reclaimable once the lease lapses and the platform-retried alarm comes back.
- **Prune** runs on every tick instead of a daily cron — it is an indexed `DELETE` that usually matches nothing. Quarantined rows (`failed_at IS NOT NULL`) are preserved for operator inspection, as everywhere else.
- **Re-arm** computes the earliest actionable instant (`nextOutboxWakeUpAt`): unclaimed rows are due at `next_attempt_at` (or immediately), crash-orphaned claims at `claimed_at + leaseMs`. Drained outbox → no alarm.

Tuning comes from the same `OUTBOX_*` vars (`[vars]` in `wrangler.do.toml`), read by the shared `readRelayTuning` / `readPruneTuning` at the DO boundary.

## RPC protocol and error boundary

The request/consumer Workers hold the DO stub behind the structural `TodoStateClient` interface (`packages/core/src/adapters/do/protocol.ts`), so only the entry files touch platform stub types.

Workers RPC serializes thrown errors into plain `Error`s — class identity does not survive the wire. The protocol therefore carries every expected outcome **as data** (`CommitResult` is `committed | conflict`), and `mapDoError` translates anything that still throws into `SystemError(DATABASE_ERROR)`. This is the DO-runtime analogue of the D1 adapter's driver-error translation.

The consumer's idempotency stamps also travel over RPC: `processed_events` lives in the DO next to the data it guards (`markEventProcessed`), not in a shared database. The consumer container (`DoConsumerContainer`) is intentionally narrower than the shared `WorkerContainer` — worker-side code has no outbox access in this topology, and the type makes that unrepresentable.

## Schema and migrations

`applyDoSchema` runs `CREATE TABLE IF NOT EXISTS` DDL synchronously in the DO constructor, before any request is delivered. Additive changes extend the DDL list; destructive changes need a versioned migration ledger (a `_meta` table), which the template intentionally leaves out. There is no drizzle-kit step and no `wrangler d1 migrations` equivalent.

## Scaling to multiple tenants

The template pins a single instance via `DEFAULT_TODO_SCOPE` (`"default"`) because its domain is one global todo list. The pattern is built for per-tenant sharding: derive the scope from the authenticated principal (`user:{id}`, `workspace:{id}`), and each tenant gets its own DO — its own SQLite file, its own outbox, its own alarm. Tenant isolation becomes structural (there is no cross-tenant table to mis-query), and outbox throughput scales with the number of active tenants instead of contending on one database. Keep per-object storage limits in mind: quarantined outbox rows are never auto-deleted, so a long-lived poison source needs operator attention before it accumulates.

## Deployment

`wrangler.do.toml` is **local-dev shaped** (unsuffixed resource names), mirroring `wrangler.toml`'s role in the D1 topology. To deploy, copy it into stage-suffixed variants (rename the Workers, the queues, and the consumer/DLQ `script_name` references), create the two queues once per stage, then:

```bash
pnpm --filter @repo/web build:do
wrangler deploy --config apps/web/wrangler.do.<stage>.toml               # app + DO
wrangler deploy --config apps/web/wrangler.do.<stage>.toml --env consumer
wrangler deploy --config apps/web/wrangler.do.<stage>.toml --env dlq
```

The `[[migrations]]` block (`new_sqlite_classes = ["TodoStateObject"]`) must accompany the first deploy of the app Worker — it is what makes the DO SQLite-backed.

## Differences vs the D1 topology

| Axis            | D1 + sibling Workers                                        | Durable Object                                          |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Store           | Shared D1 database                                          | Per-scope DO SQLite                                     |
| UoW atomicity   | Deferred `db.batch()` + `_occ_guard` CHECK abort            | Real `transactionSync`                                  |
| OCC attribution | Post-abort probe re-evaluation                              | Per-statement `RETURNING` check (exact by construction) |
| Relay trigger   | Service Binding kick + 5-min safety-net cron                | DO Alarm (guaranteed, platform-retried); no cron        |
| Pruning         | Dedicated Worker + daily cron                               | Tail of every alarm tick                                |
| Idempotency     | `processed_events` in shared D1                             | `processed_events` in the DO, reached via RPC           |
| Workers         | 5 (app / relay / consumer / pruner / dlq)                   | 2 (app+DO / consumer) + dlq                             |
| Migrations      | drizzle-kit + `wrangler d1 migrations`                      | Idempotent DDL in the DO constructor                    |
| Lock-in         | D1-flavoured but adapter-swappable to any SQLite            | Deeper: state, relay, and scheduling live on DO APIs    |

The trade: the DO topology is materially simpler to operate and strictly stronger on transactional semantics, in exchange for coupling the storage layer to Durable Objects. The hexagonal seams are what keep that coupling priced correctly — swapping back (or out to Node/AWS/GCP) is still an adapter + entry change.
