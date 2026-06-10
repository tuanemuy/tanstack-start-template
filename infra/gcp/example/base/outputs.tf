output "sa_app_email" {
  description = "App Cloud Run runtime service account email."
  value       = google_service_account.app.email
}

output "sa_relay_email" {
  description = "Relay Cloud Run runtime service account email."
  value       = google_service_account.relay.email
}

output "sa_consumer_email" {
  description = "Consumer Cloud Run runtime service account email."
  value       = google_service_account.consumer.email
}

output "sa_dlq_email" {
  description = "DLQ Cloud Run runtime service account email."
  value       = google_service_account.dlq.email
}

output "sa_scheduler_email" {
  description = "Cloud Scheduler invoker service account email."
  value       = google_service_account.scheduler.email
}

output "sa_pubsub_pusher_email" {
  description = "Pub/Sub push-subscription invoker service account email."
  value       = google_service_account.pubsub_pusher.email
}

output "events_topic_name" {
  description = "Primary events Pub/Sub topic name."
  value       = google_pubsub_topic.events.name
}

output "events_dlq_topic_name" {
  description = "Dead-letter Pub/Sub topic name."
  value       = google_pubsub_topic.events_dlq.name
}

output "events_dlq_topic_id" {
  description = "Dead-letter Pub/Sub topic full ID (projects/.../topics/...)."
  value       = google_pubsub_topic.events_dlq.id
}

output "database_auth_token_secret_name" {
  description = "Secret Manager version name for DATABASE_AUTH_TOKEN_SECRET_NAME."
  value       = "${google_secret_manager_secret.database_auth_token.id}/versions/latest"
}
