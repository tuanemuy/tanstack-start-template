import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

// Each integration test file shares a single Workers isolate (configured
// via `singleWorker: true`). Migrations run once per file, then each test
// gets a clean slate via TRUNCATE. D1 has no transaction-rollback escape
// hatch we can wrap a test in, so per-test isolation is achieved by
// explicit deletion of all rows.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM todos"),
    env.DB.prepare("DELETE FROM outbox_events"),
    env.DB.prepare("DELETE FROM _occ_guard"),
  ]);
});
