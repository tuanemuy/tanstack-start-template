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

resource "google_pubsub_topic_iam_member" "relay_publisher" {
  topic  = google_pubsub_topic.events.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.relay.email}"
}
