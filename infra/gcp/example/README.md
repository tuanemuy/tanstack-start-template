# GCP reference infrastructure (Terraform)

⚠️ **This is a reference implementation, not a production-ready
module.** It exists to make the wiring between Cloud Run, Pub/Sub,
Cloud Scheduler, and Secret Manager concrete for the GCP runtime — not
to be `terraform apply`'d into a real environment unchanged. The IAM,
networking, image hosting, and stage strategy you actually want will
likely differ.

## What it provisions

- 4 Cloud Run services (`app`, `relay`, `consumer`, `dlq`) — same image,
  different `WORKER_ROLE` env var
- Pub/Sub topic `events` + dead-letter topic `events-dlq`
- Push subscription on `events` → `consumer` service (with dead-letter
  policy)
- Push subscription on `events-dlq` → `dlq` service
- Cloud Scheduler jobs: 5-min relay safety net + daily pruner against
  the `app` service's `/prune` endpoint
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
terraform init
terraform apply \
  -var "project_id=your-gcp-project" \
  -var "region=us-central1" \
  -var "image=us-central1-docker.pkg.dev/your-gcp-project/app/server:abc123" \
  -var "turso_database_url=libsql://your-db.turso.io" \
  -var "app_url=https://app.example.com"
```

## Stage separation

Use Terraform workspaces (`terraform workspace new staging`) or a
top-level wrapper module that instantiates this directory twice with
different inputs. The example below targets a single stage to keep the
HCL skimmable.

## RELAY_URL wiring

Two services need `RELAY_URL`:

- **`app`** uses it to issue the post-UoW kick to the relay
  (`CloudRunRelayTrigger`).
- **`relay`** uses it for the saturation self-chain when one tick drains
  a full `batchSize * maxIterations` rows.

For `app`, Terraform sets `RELAY_URL = google_cloud_run_v2_service.relay.uri`
directly — `app` doesn't feed back into `relay`, so the reference is
acyclic and resolves at plan time.

For `relay`, a direct self-reference inside the same resource would be
a cycle, so a `null_resource.relay_self_url` patches the env via
`gcloud run services update --update-env-vars` after the service exists.
This requires `gcloud` on the machine running `terraform apply`. The
relay resource has `lifecycle { ignore_changes = [...env] }` so the
post-create patch isn't reverted on subsequent applies — meaning **any
later env changes you want on the relay service must be applied via
`gcloud` too**, or you must temporarily remove the `ignore_changes`
block, `terraform apply`, then put it back. If that trade-off is
unacceptable, drop the `null_resource` and run the equivalent `gcloud`
command yourself after the first apply.

Without `RELAY_URL` on the relay service, the self-chain silently
no-ops and the 5-minute Cloud Scheduler tick becomes the only path to
drain a backlog. That is degraded but not broken.
