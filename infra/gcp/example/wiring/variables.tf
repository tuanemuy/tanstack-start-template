variable "project_id" {
  description = "GCP project ID. Must match upstream stacks."
  type        = string
}

variable "region" {
  description = "GCP region. Must match upstream stacks."
  type        = string
  default     = "us-central1"
}

variable "name_prefix" {
  description = "Resource name prefix. Must match upstream stacks."
  type        = string
  default     = "tst"
}

variable "base_state_path" {
  description = "Filesystem path to the `base` stack's terraform.tfstate."
  type        = string
  default     = "../base/terraform.tfstate"
}

variable "services_state_path" {
  description = "Filesystem path to the `services` stack's terraform.tfstate."
  type        = string
  default     = "../services/terraform.tfstate"
}
