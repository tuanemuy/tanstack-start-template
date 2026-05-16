locals {
  prefix = var.name_prefix
}

# ----- Secret Manager --------------------------------------------------------

resource "google_secret_manager_secret" "database_auth_token" {
  secret_id = "${local.prefix}-database-auth-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "database_auth_token" {
  secret      = google_secret_manager_secret.database_auth_token.id
  secret_data = var.turso_auth_token
}

# ----- Service accounts ------------------------------------------------------

resource "google_service_account" "app" {
  account_id   = "${local.prefix}-app"
  display_name = "Cloud Run: app service"
}

resource "google_service_account" "relay" {
  account_id   = "${local.prefix}-relay"
  display_name = "Cloud Run: relay service"
}

resource "google_service_account" "consumer" {
  account_id   = "${local.prefix}-consumer"
  display_name = "Cloud Run: consumer service"
}

resource "google_service_account" "dlq" {
  account_id   = "${local.prefix}-dlq"
  display_name = "Cloud Run: dlq service"
}

resource "google_service_account" "scheduler" {
  account_id   = "${local.prefix}-scheduler"
  display_name = "Cloud Scheduler invoker"
}

resource "google_service_account" "pubsub_pusher" {
  account_id   = "${local.prefix}-pubsub-push"
  display_name = "Pub/Sub push subscription invoker"
}

# Grant each Cloud Run runtime SA access to the Turso token secret.
locals {
  secret_consumers = toset([
    google_service_account.app.email,
    google_service_account.relay.email,
    google_service_account.consumer.email,
    google_service_account.dlq.email,
  ])
}

resource "google_secret_manager_secret_iam_member" "database_auth_token" {
  for_each  = local.secret_consumers
  secret_id = google_secret_manager_secret.database_auth_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.key}"
}

# ----- Pub/Sub topics --------------------------------------------------------

resource "google_pubsub_topic" "events" {
  name = "${local.prefix}-${var.events_topic_name}"
}

resource "google_pubsub_topic" "events_dlq" {
  name = "${local.prefix}-${var.events_topic_name}-dlq"
}

# The relay service publishes to the main topic.
resource "google_pubsub_topic_iam_member" "relay_publisher" {
  topic  = google_pubsub_topic.events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.relay.email}"
}

# ----- Cloud Run services ----------------------------------------------------

locals {
  shared_env = {
    DATABASE_URL  = var.turso_database_url
    APP_URL       = var.app_url
    EVENTS_TOPIC  = google_pubsub_topic.events.name
    GCP_PROJECT_ID = var.project_id
    DATABASE_AUTH_TOKEN_SECRET_NAME = "${google_secret_manager_secret.database_auth_token.id}/versions/latest"
  }
}

# Cloud Run v2 service factory: produces one service per role. We can't
# use `for_each` over a module here (no module-level inputs vary much
# beyond name + SA + role + env), so the four are spelled out below to
# keep the diff readable.

resource "google_cloud_run_v2_service" "app" {
  name     = "${local.prefix}-app"
  location = var.region
  template {
    service_account = google_service_account.app.email
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      dynamic "env" {
        # `RELAY_URL` references the relay service URL directly — Cloud
        # Run v2 resolves cross-service URIs at plan time and `app` does
        # not feed back into `relay`, so there is no dependency cycle.
        for_each = merge(local.shared_env, {
          WORKER_ROLE = "app"
          RELAY_URL   = google_cloud_run_v2_service.relay.uri
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = { for k, v in var.outbox_tuning : upper(k) => v if v != null }
        content {
          name  = "OUTBOX_${env.key}"
          value = env.value
        }
      }
    }
    scaling {
      min_instance_count = 1
    }
  }
}

resource "google_cloud_run_v2_service" "relay" {
  name     = "${local.prefix}-relay"
  location = var.region
  template {
    service_account = google_service_account.relay.email
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      dynamic "env" {
        for_each = merge(local.shared_env, { WORKER_ROLE = "relay" })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = { for k, v in var.outbox_tuning : upper(k) => v if v != null }
        content {
          name  = "OUTBOX_${env.key}"
          value = env.value
        }
      }
    }
  }
  # `RELAY_URL` (self-reference, for the saturation self-chain in
  # `runRelayTick`) is wired into the relay container in a post-create
  # pass via `null_resource.relay_self_url`. A direct self-reference on
  # the same resource would create a Terraform dependency cycle, and the
  # service URL is only knowable once Cloud Run assigns it.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].env,
    ]
  }
}

# Post-create pass: stamp `RELAY_URL` onto the relay service so the
# self-chained POST in `runRelayTick` (when a tick saturates
# `maxIterations`) can find its own URL. Re-runs whenever the relay URL
# changes. Requires `gcloud` on the apply host.
resource "null_resource" "relay_self_url" {
  triggers = {
    relay_uri    = google_cloud_run_v2_service.relay.uri
    service_name = google_cloud_run_v2_service.relay.name
    region       = var.region
    project      = var.project_id
  }

  provisioner "local-exec" {
    command = <<-EOT
      gcloud run services update ${google_cloud_run_v2_service.relay.name} \
        --project=${var.project_id} \
        --region=${var.region} \
        --update-env-vars=RELAY_URL=${google_cloud_run_v2_service.relay.uri}
    EOT
  }

  depends_on = [google_cloud_run_v2_service.relay]
}

resource "google_cloud_run_v2_service" "consumer" {
  name     = "${local.prefix}-consumer"
  location = var.region
  template {
    service_account = google_service_account.consumer.email
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      dynamic "env" {
        for_each = merge(local.shared_env, { WORKER_ROLE = "consumer" })
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service" "dlq" {
  name     = "${local.prefix}-dlq"
  location = var.region
  template {
    service_account = google_service_account.dlq.email
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      dynamic "env" {
        for_each = merge(local.shared_env, { WORKER_ROLE = "dlq" })
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

# ----- Service-to-service invoker bindings -----------------------------------

# app -> relay (CloudRunRelayTrigger POSTs after UoW commit)
resource "google_cloud_run_v2_service_iam_member" "relay_invoker_app" {
  name     = google_cloud_run_v2_service.relay.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.app.email}"
}

# scheduler -> relay (5-min cron)
resource "google_cloud_run_v2_service_iam_member" "relay_invoker_scheduler" {
  name     = google_cloud_run_v2_service.relay.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# scheduler -> app /prune (daily cron)
resource "google_cloud_run_v2_service_iam_member" "app_invoker_scheduler" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# relay -> relay (self-chain)
resource "google_cloud_run_v2_service_iam_member" "relay_invoker_self" {
  name     = google_cloud_run_v2_service.relay.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.relay.email}"
}

# Pub/Sub push -> consumer / dlq
resource "google_cloud_run_v2_service_iam_member" "consumer_invoker_pubsub" {
  name     = google_cloud_run_v2_service.consumer.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_pusher.email}"
}

resource "google_cloud_run_v2_service_iam_member" "dlq_invoker_pubsub" {
  name     = google_cloud_run_v2_service.dlq.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_pusher.email}"
}

# Public access to the app service. Replace with a restricted policy if
# you front Cloud Run with a load balancer / IAP.
resource "google_cloud_run_v2_service_iam_member" "app_public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ----- Pub/Sub subscriptions -------------------------------------------------

resource "google_pubsub_subscription" "events_consumer" {
  name  = "${local.prefix}-events-to-consumer"
  topic = google_pubsub_topic.events.name

  push_config {
    push_endpoint = google_cloud_run_v2_service.consumer.uri
    oidc_token {
      service_account_email = google_service_account.pubsub_pusher.email
      # The audience is the receiving service URL by default; setting
      # it explicitly avoids drift if Cloud Run renames the host.
      audience = google_cloud_run_v2_service.consumer.uri
    }
  }

  ack_deadline_seconds = 60

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.events_dlq.id
    max_delivery_attempts = 5
  }
}

resource "google_pubsub_subscription" "events_dlq_sink" {
  name  = "${local.prefix}-events-dlq-to-dlq"
  topic = google_pubsub_topic.events_dlq.name

  push_config {
    push_endpoint = google_cloud_run_v2_service.dlq.uri
    oidc_token {
      service_account_email = google_service_account.pubsub_pusher.email
      audience              = google_cloud_run_v2_service.dlq.uri
    }
  }

  ack_deadline_seconds = 60
}

# Pub/Sub-managed SA needs publisher rights on the dead-letter topic so
# it can forward failed deliveries. The project's default Pub/Sub SA is
# `service-{project_number}@gcp-sa-pubsub.iam.gserviceaccount.com`; you
# may need to grant `roles/pubsub.publisher` to it on the DLQ topic in a
# separate manual step (omitted here to keep the example region-agnostic).

# ----- Cloud Scheduler -------------------------------------------------------

resource "google_cloud_scheduler_job" "relay_tick" {
  name        = "${local.prefix}-relay-tick"
  region      = var.region
  schedule    = "*/5 * * * *"
  description = "Relay safety-net: drain the outbox every 5 minutes."

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.relay.uri}/"
    body        = base64encode("{}")
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = google_cloud_run_v2_service.relay.uri
    }
  }
}

resource "google_cloud_scheduler_job" "prune_tick" {
  name        = "${local.prefix}-prune-tick"
  region      = var.region
  schedule    = "0 3 * * *"
  description = "Daily outbox pruning."

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.app.uri}/prune"
    body        = base64encode("{}")
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = google_cloud_run_v2_service.app.uri
    }
  }
}
