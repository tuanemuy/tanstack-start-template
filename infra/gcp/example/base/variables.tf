variable "project_id" {
  description = "GCP project ID to deploy into."
  type        = string
}

variable "region" {
  description = "GCP region for Pub/Sub. Match the region used by the `services` stack."
  type        = string
  default     = "us-central1"
}

variable "name_prefix" {
  description = "Prefix applied to every resource. Use this to namespace staging vs production within the same project."
  type        = string
  default     = "tst"
}

variable "turso_auth_token" {
  description = "Turso auth token. Written into Secret Manager and mounted by the `services` stack. Pass via -var-file or TF_VAR_turso_auth_token so it never lands in shell history."
  type        = string
  sensitive   = true
}

variable "events_topic_name" {
  description = "Pub/Sub topic name (no projects/... prefix)."
  type        = string
  default     = "events"
}
