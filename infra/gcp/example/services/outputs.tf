output "app_url" {
  description = "Public URL of the app Cloud Run service."
  value       = google_cloud_run_v2_service.app.uri
}

output "app_name" {
  description = "Cloud Run service name for the app role."
  value       = google_cloud_run_v2_service.app.name
}

output "relay_url" {
  description = "Internal URL of the relay Cloud Run service."
  value       = google_cloud_run_v2_service.relay.uri
}

output "relay_name" {
  description = "Cloud Run service name for the relay role."
  value       = google_cloud_run_v2_service.relay.name
}

output "consumer_url" {
  description = "Internal URL of the consumer Cloud Run service."
  value       = google_cloud_run_v2_service.consumer.uri
}

output "consumer_name" {
  description = "Cloud Run service name for the consumer role."
  value       = google_cloud_run_v2_service.consumer.name
}

output "dlq_url" {
  description = "Internal URL of the dlq Cloud Run service."
  value       = google_cloud_run_v2_service.dlq.uri
}

output "dlq_name" {
  description = "Cloud Run service name for the dlq role."
  value       = google_cloud_run_v2_service.dlq.name
}
