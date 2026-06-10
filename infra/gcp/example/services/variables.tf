variable "project_id" {
  description = "GCP project ID. Must match the `base` stack."
  type        = string
}

variable "region" {
  description = "GCP region for Cloud Run. Match the `base` stack."
  type        = string
  default     = "us-central1"
}

variable "name_prefix" {
  description = "Resource name prefix. Must match the `base` stack."
  type        = string
  default     = "tst"
}

variable "image" {
  description = "Container image (repository + tag/digest) to deploy. The same image is used for every Cloud Run service; WORKER_ROLE differentiates them."
  type        = string
}

variable "turso_database_url" {
  description = "Turso libsql:// URL. Stored as a Cloud Run env var (URL alone is low-sensitivity)."
  type        = string
}

variable "app_url" {
  description = "Public origin of the app. Used by APP_URL for absolute-URL building."
  type        = string
}

variable "outbox_tuning" {
  description = "Optional outbox tuning overrides. Empty values fall back to the application-layer defaults."
  type = object({
    batch_size   = optional(string)
    lease_ms     = optional(string)
    max_attempts = optional(string)
    retention_ms = optional(string)
  })
  default = {}
}

variable "base_state_path" {
  description = "Filesystem path to the `base` stack's terraform.tfstate, read via terraform_remote_state."
  type        = string
  default     = "../base/terraform.tfstate"
}
