# Staging deploy config TEMPLATE — rendered to `wrangler.staging.toml` by
# `pnpm cf:render:staging`, which substitutes `${...}`
# placeholders with outputs from the `cf-resources/staging` Pulumi stack.
#
# Source of truth: this `.tpl` file (committed) + Pulumi state.
# The rendered `wrangler.staging.toml` is git-ignored — do not edit it
# directly; re-run the render script instead.
#
# === Before first deploy =================================================
#   1. `pulumi -C infra/cloudflare/pulumi/resources -s staging up`
#   2. `pnpm cf:render:staging`
#   3. `wrangler secret put <NAME> --config wrangler.staging.toml [--env <role>]`
#   4. `wrangler deploy -c wrangler.staging.toml` (+ each `--env <role>`)
#   5. `pulumi -C infra/cloudflare/pulumi/routes -s staging up`
# =========================================================================
#
# Wrangler does NOT inherit `d1_databases` / `vars` from top level into
# named environments — every `[env.*]` block re-declares them. Placeholders
# below keep them in sync; do not hand-edit the rendered file.
name = "${RESOURCE_PREFIX}"
main = "app/server.cloudflare.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist/client"
binding = "ASSETS"

[vars]
APP_URL = "${APP_URL}"

[[d1_databases]]
binding = "DB"
database_name = "${D1_DATABASE_NAME}"
database_id = "${D1_DATABASE_ID}"
migrations_dir = "../../packages/core/src/adapters/d1/migrations"

[[services]]
binding = "RELAY"
service = "${RESOURCE_PREFIX}-relay"


# === Relay (Service Binding fetch + safety-net cron) ====================
[env.relay]
name = "${RESOURCE_PREFIX}-relay"
main = "app/worker/cloudflare/relay.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[env.relay.vars]
APP_URL = "${APP_URL}"
OUTBOX_BATCH_SIZE = "100"
OUTBOX_LEASE_MS = "300000"   # 5 min — covers worst-case single-batch dispatch
OUTBOX_MAX_ATTEMPTS = "2"    # multiplied by [env.consumer] max_retries — keep low

[[env.relay.d1_databases]]
binding = "DB"
database_name = "${D1_DATABASE_NAME}"
database_id = "${D1_DATABASE_ID}"
migrations_dir = "../../packages/core/src/adapters/d1/migrations"

[[env.relay.queues.producers]]
binding = "EVENTS_QUEUE"
queue = "${EVENTS_QUEUE_NAME}"

[env.relay.triggers]
crons = ["*/5 * * * *"]


# === Consumer ===========================================================
[env.consumer]
name = "${RESOURCE_PREFIX}-consumer"
main = "app/worker/cloudflare/consumer.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[env.consumer.vars]
APP_URL = "${APP_URL}"

[[env.consumer.d1_databases]]
binding = "DB"
database_name = "${D1_DATABASE_NAME}"
database_id = "${D1_DATABASE_ID}"
migrations_dir = "../../packages/core/src/adapters/d1/migrations"

[[env.consumer.queues.consumers]]
queue = "${EVENTS_QUEUE_NAME}"
max_batch_size = 25
max_batch_timeout = 30 # seconds
max_retries = 3
dead_letter_queue = "${DLQ_QUEUE_NAME}"


# === Pruner =============================================================
[env.pruner]
name = "${RESOURCE_PREFIX}-pruner"
main = "app/worker/cloudflare/pruner.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[env.pruner.vars]
APP_URL = "${APP_URL}"
OUTBOX_RETENTION_MS = "604800000"   # 7 days

[[env.pruner.d1_databases]]
binding = "DB"
database_name = "${D1_DATABASE_NAME}"
database_id = "${D1_DATABASE_ID}"
migrations_dir = "../../packages/core/src/adapters/d1/migrations"

[env.pruner.triggers]
crons = ["0 3 * * *"] # 03:00 UTC daily


# === DLQ ================================================================
[env.dlq]
name = "${RESOURCE_PREFIX}-dlq"
main = "app/worker/cloudflare/dlq.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[env.dlq.vars]
APP_URL = "${APP_URL}"

[[env.dlq.d1_databases]]
binding = "DB"
database_name = "${D1_DATABASE_NAME}"
database_id = "${D1_DATABASE_ID}"
migrations_dir = "../../packages/core/src/adapters/d1/migrations"

[[env.dlq.queues.consumers]]
queue = "${DLQ_QUEUE_NAME}"
max_batch_size = 25
max_batch_timeout = 30 # seconds
max_retries = 1
