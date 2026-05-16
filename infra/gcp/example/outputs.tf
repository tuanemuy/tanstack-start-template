output "app_url" {
  description = "Public URL of the app Cloud Run service. Set this as APP_URL on the next deploy if it differs from the user-facing domain."
  value       = google_cloud_run_v2_service.app.uri
}

output "relay_url" {
  description = "Internal URL of the relay Cloud Run service (already wired into the app service's RELAY_URL env var by this module)."
  value       = google_cloud_run_v2_service.relay.uri
}

output "consumer_url" {
  description = "Internal URL of the consumer Cloud Run service. Used as the push endpoint for the events subscription."
  value       = google_cloud_run_v2_service.consumer.uri
}

output "dlq_url" {
  description = "Internal URL of the dlq Cloud Run service."
  value       = google_cloud_run_v2_service.dlq.uri
}

output "events_topic" {
  description = "Pub/Sub topic the relay publishes to."
  value       = google_pubsub_topic.events.name
}

output "events_dlq_topic" {
  description = "Pub/Sub dead-letter topic name."
  value       = google_pubsub_topic.events_dlq.name
}

output "database_auth_token_secret_name" {
  description = "Secret Manager version name to pass as DATABASE_AUTH_TOKEN_SECRET_NAME to each service (already wired into the Cloud Run env in this module)."
  value       = "${google_secret_manager_secret.database_auth_token.id}/versions/latest"
}
