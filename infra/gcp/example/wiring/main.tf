locals {
  prefix = var.name_prefix
}

data "terraform_remote_state" "base" {
  backend = "local"
  config = {
    path = var.base_state_path
  }
}

data "terraform_remote_state" "services" {
  backend = "local"
  config = {
    path = var.services_state_path
  }
}

locals {
  base     = data.terraform_remote_state.base.outputs
  services = data.terraform_remote_state.services.outputs
}

# ----- Service-to-service invoker bindings -----------------------------------

# app -> relay (CloudRunRelayTrigger POSTs after UoW commit).
resource "google_cloud_run_v2_service_iam_member" "relay_invoker_app" {
  name     = local.services.relay_name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.base.sa_app_email}"
}

# scheduler -> relay (5-min cron).
resource "google_cloud_run_v2_service_iam_member" "relay_invoker_scheduler" {
  name     = local.services.relay_name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.base.sa_scheduler_email}"
}

# scheduler -> pruner (daily cron). The pruner deliberately has no
# `allUsers` binding — this is the only invoker, so IAM actually gates
# the endpoint (routing prune through the public app service would not).
resource "google_cloud_run_v2_service_iam_member" "pruner_invoker_scheduler" {
  name     = local.services.pruner_name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.base.sa_scheduler_email}"
}

# Pub/Sub push -> consumer / dlq.
resource "google_cloud_run_v2_service_iam_member" "consumer_invoker_pubsub" {
  name     = local.services.consumer_name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.base.sa_pubsub_pusher_email}"
}

resource "google_cloud_run_v2_service_iam_member" "dlq_invoker_pubsub" {
  name     = local.services.dlq_name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.base.sa_pubsub_pusher_email}"
}

# Public access to the app service. Replace with a restricted policy if
# you front Cloud Run with a load balancer / IAP.
resource "google_cloud_run_v2_service_iam_member" "app_public" {
  name     = local.services.app_name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ----- Pub/Sub subscriptions -------------------------------------------------

resource "google_pubsub_subscription" "events_consumer" {
  name  = "${local.prefix}-events-to-consumer"
  topic = local.base.events_topic_name

  push_config {
    push_endpoint = local.services.consumer_url
    oidc_token {
      service_account_email = local.base.sa_pubsub_pusher_email
      audience              = local.services.consumer_url
    }
  }

  ack_deadline_seconds = 60

  dead_letter_policy {
    dead_letter_topic     = local.base.events_dlq_topic_id
    max_delivery_attempts = 5
  }
}

resource "google_pubsub_subscription" "events_dlq_sink" {
  name  = "${local.prefix}-events-dlq-to-dlq"
  topic = local.base.events_dlq_topic_name

  push_config {
    push_endpoint = local.services.dlq_url
    oidc_token {
      service_account_email = local.base.sa_pubsub_pusher_email
      audience              = local.services.dlq_url
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
    uri         = "${local.services.relay_url}/"
    body        = base64encode("{}")
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = local.base.sa_scheduler_email
      audience              = local.services.relay_url
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
    uri         = "${local.services.pruner_url}/"
    body        = base64encode("{}")
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = local.base.sa_scheduler_email
      audience              = local.services.pruner_url
    }
  }
}
