# Testing

Tests are classified along two axes: **layer × purpose**. By separating a fast unit layer from an integration layer that verifies concurrent / OCC behavior against a real DB, we keep the day-to-day development loop light while continuously covering adapter pitfalls.

## Test layer classification

### Unit (`pnpm test:unit`)

- **Targets**: domain-layer + application-layer logic (the pure parts).
- **Dependencies**: the only fakes kept on hand are the two under `packages/core/src/application/__tests__/fakes/`: `FakeIdGenerator` (a deterministic UUIDv7 stream) and `FakeLogger` (a recording Logger). `Clock` can simply be passed to the usecase as a freestanding `now: Date`, and repository-style fakes are intentionally absent (the judgment being that imitating transaction / OCC with an in-memory fake is no substitute for integration). We don't aim to exhaustively cover application-layer logic with fakes; behavior verification is pushed onto integration tests.
- **Aim**: invariants of the domain layer (value object / entity / events decoding), error-code branching, and the behavior of application-layer helpers like `retry()`.
- **Speed**: a few to a dozen-or-so milliseconds. Vitest's `--exclude '**/*.integration.test.ts'` skips integration.
- **Naming**: `**/__tests__/<target>.test.ts` (e.g. `entity.test.ts`, `events.test.ts`, `retry.test.ts`).

### Integration (`pnpm test:integration`)

- **Targets**: the Drizzle SQLite adapter implementation, adapter × application integration, concurrent / OCC (optimistic concurrency control) scenarios, and outbox poll / dispatch behavior.
- **Dependencies**: real SQLite through two pools. Cloudflare tests use an in-memory Miniflare D1 binding; Node tests create isolated temporary libSQL databases and close each client during teardown.
- **Aim**: realistically verify transaction rollback, the adapter's built-in `SQLITE_BUSY` retry, `OptimisticLockFailure`, and the outbox's `claimPending` / `finalize`.
- **Speed**: roughly 10× unit. Day to day you run `pnpm test:unit`, and run `pnpm test:integration` when you touch an adapter or before a PR.
- **Naming**: `**/__tests__/<target>.integration.test.ts` (e.g. `todo.integration.test.ts`, `todoRepository.integration.test.ts`, `outboxRepository.integration.test.ts`).

### Property-based (fast-check)

- **Targets**: value-object invariants, entity state transitions, and edge cases that fail under random input.
- **Dependencies**: `fast-check` (devDependency).
- **Aim**: automatically verify properties such as "if the post-trim length is 1-140 it is always accepted", "`complete` → `reopen` returns to the original active state", and "change status is idempotent for the same input" over hundreds of samples.
- **When to use**: boundary values (TitleEmpty / TitleTooLong), state transitions (active ⇄ completed), invariants (monotonic increase of `version`). Keep custom arbitraries to the bare minimum, and use combinations of `fc.string()` / `fc.integer()` for anything that can be written that way.
- **Naming**: `**/__tests__/<target>.property.test.ts` (e.g. `valueObject.property.test.ts`, `entity.property.test.ts`).

## Fake policy

Currently the following two are the only fakes kept under `packages/core/src/application/__tests__/fakes/`:

- **`FakeIdGenerator`** — returns deterministic ids by embedding a counter into a UUIDv7 template. The output is shaped to pass the adapter-side rehydration validation (`IdGenerator.validate`), so it won't fail format checks even in round-trip tests through storage. The starting number can be fixed via `seed`, and the prefix is set to `f0...` so that generated ids sort after the test's outbox rows (they come after the test-fixed `01950000-...` series when sorting by `(createdAt, id)`).
- **`FakeLogger`** — merely records each `info` / `warn` / `error` call into an `entries` array. Use `byLevel("error")` to extract them and assert on the observability behavior of the relay worker / usecase.

Fakes for repositories, the UoW, and the Clock are intentionally not kept.

- Even if you fake repositories / the UoW in-memory, you can't reproduce the essential adapter-derived behaviors like transactions, `SQLITE_BUSY` retry, or `OptimisticLockFailure`. Logic tests for application services are better done at the integration layer (real SQLite), where they cover actual harm.
- `Clock` is just a `() => Date`, so it's enough to construct a constant like `new Date(0)` within a test and pass it to the usecase / domain. There's no need to fake it as a port object.

## Real DB test (integration) policy

- `pnpm test:integration:cf` runs D1/application/Cloudflare-worker tests against a **Workers isolate + Miniflare D1 binding** via `vitest-pool-workers`. `vitest.config.integration.ts` handles the pool configuration, and `packages/core/src/adapters/d1/__tests__/setup.ts` handles applying migrations and the `beforeEach` TRUNCATE.
- `pnpm test:integration:node` runs libSQL adapter and Node worker-runner tests through `vitest.config.integration.node.ts`; each test owns an isolated temporary database.
- `setupTestContainer()` (`packages/core/src/application/__tests__/helpers.ts`) returns a production-equivalent, D1-backed container from `env.DB`. Cross-test state cleanup is handled by the global setup, so the helper is just a factory + getter.
- File names are `*.integration.test.ts`. The Node pool's `vitest.config.ts` excludes this pattern and runs only unit tests.
- When writing tests that are conscious of concurrent / OCC, use patterns such as firing `run` simultaneously with `Promise.all` and observing `OptimisticLockFailure`. In D1's deferred-batch UoW, a race branches such that one side hits a CHECK violation on `_occ_guard` and the other gets an empty batch, so keep assertions loose enough to pass under either failure shape for stability.

## Property-based policy

- fast-check is adopted mainly to verify **boundary values + invariants**.
- It's useful for property checks such as each domain value-object factory, entity state transitions (`complete` → `reopen` returns to the active state, the idempotency where repeating `rename` with the same value doesn't increment version, etc.), and the idempotency of set-style usecases.
- Before writing a custom arbitrary, consider whether existing `fc.string()` / `fc.integer()` plus `filter` suffice. Don't make the domain overly dependent on fast-check.

## Timeout / flakiness

- The configs currently use Vitest's default timeouts. Unit tests finish in a few hundred milliseconds; if an integration test needs a longer ceiling, set it in the runtime-specific integration config rather than slowing the unit suite.
- If the backoff of the adapter's built-in transient retry stacks up, a single test can consume several seconds. When you sense flakiness, before fixing the clock with per-test `test.extend` / `vi.useFakeTimers`, first check the adapter's retry settings.
- When a test with no retries (a simple CRUD success path, etc.) times out, a `SQLITE_BUSY` is often lurking. Check whether it reproduces on the integration side.

## Commands

| Purpose | Command |
| --- | --- |
| All | `pnpm test` |
| Unit only | `pnpm test:unit` |
| Integration only | `pnpm test:integration` |
| Todo application unit tests | `pnpm exec vitest run packages/core/src/application/todo` |
| Todo domain unit tests | `pnpm exec vitest run packages/core/src/domain/todo` |

## Coverage

Coverage numbers are not enforced. Rules of thumb:

- **Domain**: aim for ~100%. Logic is local and easy to fully cover, and a missing test translates directly into a broken invariant.
- **Application + Adapter (integration)**: per "representative path". Provide at least one for each route, such as OCC success / OCC failure, same-tx placement of the outbox, per-row isolation of relay-worker decode failures, and the race of a concurrent delete. For usecase orchestration coverage, prioritize confirming it "ran on a real DB" via integration over exhaustive coverage with fakes.
- **Frontend**: the bare minimum. The server function's wire-type boundary and UI logic are broadly covered by the behavior of Conform / Zod and `useActionState` / `useOptimistic`.
