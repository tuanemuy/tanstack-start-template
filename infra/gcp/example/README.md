# GCP reference infrastructure (Terraform)

⚠️ **This is a reference implementation, not a production-ready
module.** It exists to make the wiring between Cloud Run, Pub/Sub,
Cloud Scheduler, and Secret Manager concrete for the GCP runtime — not
to be `terraform apply`'d into a real environment unchanged. The IAM,
networking, image hosting, and stage strategy you actually want will
likely differ.

## Layout

Split across three sibling root modules. Apply them in order; each
later stack reads the previous stack's `terraform.tfstate` via
`terraform_remote_state` (local backend in this example — swap for GCS
in a real deployment).

```
base/      # Secret Manager + Service Accounts + Pub/Sub topics
services/  # Cloud Run services (app, relay, consumer, dlq)
wiring/    # Service-to-service IAM, Pub/Sub subscriptions, Cloud Scheduler
```

The split exists so that Cloud Run URLs (only knowable after services
exist) can be consumed by Pub/Sub push subscriptions and Cloud
Scheduler jobs without an intra-stack dependency cycle — see
[RELAY_URL wiring](#relay_url-wiring) below.

## What it provisions

- 4 Cloud Run services (`app`, `relay`, `consumer`, `dlq`) — same image,
  different `WORKER_ROLE` env var
- Pub/Sub topic `events` + dead-letter topic `events-dlq`
- Push subscription on `events` → `consumer` service (with dead-letter
  policy)
- Push subscription on `events-dlq` → `dlq` service
- Cloud Scheduler jobs: 5-min relay safety net + daily tick against the
  dedicated `pruner` service (scheduler SA is its only invoker)
- Secret Manager secret `database-auth-token`
- Service accounts + IAM bindings for service-to-service invocation

## What it does **not** provision

- The container image. Build + push via Cloud Build / `gcloud builds
  submit` / local `docker push` separately and pass the resulting
  digest as the `image` variable.
- Turso. Create the database manually via `turso db create` and store
  the URL and auth token as Terraform variables / in Secret Manager.
- A custom domain / load balancer. Cloud Run exposes a public URL out
  of the box; wire your own domain when you need one.
- Logging / monitoring policy. Cloud Logging captures stdout
  automatically; alerting is out of scope.

## Usage sketch

```bash
cd infra/gcp/example

# 1) Persistent identity / messaging layer
( cd base && terraform init && terraform apply \
    -var "project_id=your-gcp-project" \
    -var "region=us-central1" \
    -var "turso_auth_token=$TURSO_AUTH_TOKEN" )

# 2) Cloud Run services (reads base/terraform.tfstate)
( cd services && terraform init && terraform apply \
    -var "project_id=your-gcp-project" \
    -var "region=us-central1" \
    -var "image=us-central1-docker.pkg.dev/your-gcp-project/app/server:abc123" \
    -var "turso_database_url=libsql://your-db.turso.io" \
    -var "app_url=https://app.example.com" )

# 3) Subscriptions + Scheduler + invoker bindings
( cd wiring && terraform init && terraform apply \
    -var "project_id=your-gcp-project" \
    -var "region=us-central1" )
```

Pass `-var "name_prefix=..."` consistently across all three stacks if
you customise it.

## Stage separation

Use Terraform workspaces per stack (`terraform workspace new staging`
inside each of `base/`, `services/`, `wiring/`), or wrap the three
directories in a top-level module that instantiates them twice with
different inputs. The example targets a single stage to keep the HCL
skimmable.

## RELAY_URL wiring

Two services originally needed `RELAY_URL`:

- **`app`** uses it to issue the post-UoW kick to the relay
  (`CloudRunRelayTrigger`).
- **`relay`** previously used it for the saturation self-chain when one
  tick drained a full `batchSize * maxIterations` rows.

For `app`, the in-stack reference
`RELAY_URL = google_cloud_run_v2_service.relay.uri` is acyclic — `app`
references `relay` but not the other way round — so the `services`
stack resolves it at plan time.

The relay self-chain has been **intentionally dropped** in this
layout. A self-reference is a Terraform cycle, and the previous flat
layout worked around it with a `null_resource` + `gcloud run services
update` post-create patch plus `lifecycle { ignore_changes = [...env] }`
— a hack that fights Terraform's ownership model and requires `gcloud`
on the apply host. The trade-off this layout takes:

- ✅ No `gcloud` dependency on the apply host
- ✅ No `lifecycle.ignore_changes` masking real drift
- ✅ Clean three-stack apply with no cycles
- ⚠️ Without `RELAY_URL` on the relay service, the saturation self-chain
  is a silent no-op. The 5-minute Cloud Scheduler tick becomes the only
  path to drain a backlog. **Degraded but not broken** — at-least-once
  delivery and idempotent consumers are unaffected.

If you need the self-chain back, options in increasing order of
invasiveness:

1. Add a fourth `relay-env-patch/` stack that runs `gcloud run services
   update` via `terraform_data` after `services/` — the original hack,
   scoped to a deliberate post-apply step.
2. Teach the relay handler to read its own URL from the incoming
   request's `Host` header on first invocation and cache it, removing
   the need for any env var injection.
