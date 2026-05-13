import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect } from "vitest";

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
    env.DB.prepare("DELETE FROM processed_events"),
  ]);
});

// `_occ_guard` must stay empty by construction: the CHECK (`n > 0`) aborts
// the batch the moment a guard row with `n = 0` is attempted, so no row
// can ever persist on either the success or conflict path. A non-empty
// table means the CHECK was bypassed (schema regression, migration drift)
// — exactly the class of bug a blanket `DELETE FROM _occ_guard` in setup
// would have silently swept under the rug.
afterEach(async () => {
  const { results } = await env.DB.prepare("SELECT 1 FROM _occ_guard").all();
  expect(results).toHaveLength(0);
});
