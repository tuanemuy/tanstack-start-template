variable "project_id" {
  description = "GCP project ID to deploy into."
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run / Pub/Sub / Scheduler. Pick the region closest to your Turso primary location."
  type        = string
  default     = "us-central1"
}

variable "name_prefix" {
  description = "Prefix applied to every resource. Use this to namespace staging vs production within the same project."
  type        = string
  default     = "tst"
}

variable "image" {
  description = "Container image (repository + tag/digest) to deploy. The same image is used for every Cloud Run service; WORKER_ROLE differentiates them."
  type        = string
}

variable "turso_database_url" {
  description = "Turso libsql:// URL. Stored as a Cloud Run env var, not a secret (URL alone is low-sensitivity)."
  type        = string
}

variable "turso_auth_token" {
  description = "Turso auth token. Written into Secret Manager and mounted into the Cloud Run services as DATABASE_AUTH_TOKEN. Pass via -var-file or TF_VAR_turso_auth_token so it never lands in shell history."
  type        = string
  sensitive   = true
}

variable "app_url" {
  description = "Public origin of the app. Used by APP_URL for absolute-URL building."
  type        = string
}

variable "events_topic_name" {
  description = "Pub/Sub topic name (no projects/... prefix)."
  type        = string
  default     = "events"
}

variable "outbox_tuning" {
  description = "Optional outbox tuning overrides. Empty values fall back to the application-layer defaults."
  type = object({
    batch_size    = optional(string)
    lease_ms      = optional(string)
    max_attempts  = optional(string)
    retention_ms  = optional(string)
  })
  default = {}
}
