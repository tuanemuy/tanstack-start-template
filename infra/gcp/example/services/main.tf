data "terraform_remote_state" "base" {
  backend = "local"
  config = {
    path = var.base_state_path
  }
}

locals {
  prefix = var.name_prefix

  shared_env = {
    DATABASE_URL                    = var.turso_database_url
    APP_URL                         = var.app_url
    EVENTS_TOPIC                    = data.terraform_remote_state.base.outputs.events_topic_name
    GCP_PROJECT_ID                  = var.project_id
    DATABASE_AUTH_TOKEN_SECRET_NAME = data.terraform_remote_state.base.outputs.database_auth_token_secret_name
  }

  outbox_env = { for k, v in var.outbox_tuning : "OUTBOX_${upper(k)}" => v if v != null }
}

# The app service kicks the relay synchronously after each UoW commit
# (`CloudRunRelayTrigger`). `RELAY_URL` is resolved at plan time from the
# in-stack relay resource — there is no cycle because `relay` does not
# reference `app`.
resource "google_cloud_run_v2_service" "app" {
  name     = "${local.prefix}-app"
  location = var.region
  template {
    service_account = data.terraform_remote_state.base.outputs.sa_app_email
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      dynamic "env" {
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
        for_each = local.outbox_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
    scaling {
      min_instance_count = 1
    }
  }
}

# The relay service intentionally omits `RELAY_URL` for itself. The
# saturation self-chain in `runRelayTick` is a performance optimisation;
# without it the 5-minute Scheduler tick remains the safety net and a
# backlog drains more slowly but correctly. A service cannot reference
# its own URL in Terraform without a dependency cycle, so injecting
# `RELAY_URL` here would require post-deploy patching
# (`null_resource` + `gcloud run services update`).
resource "google_cloud_run_v2_service" "relay" {
  name     = "${local.prefix}-relay"
  location = var.region
  template {
    service_account = data.terraform_remote_state.base.outputs.sa_relay_email
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
        for_each = local.outbox_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service" "consumer" {
  name     = "${local.prefix}-consumer"
  location = var.region
  template {
    service_account = data.terraform_remote_state.base.outputs.sa_consumer_email
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

# Pruning runs as its own service, NOT as a route on `app`: the app
# service holds an `allUsers` invoker, so any endpoint it serves is
# public no matter which service accounts are also granted
# `roles/run.invoker`. A dedicated service with no public binding lets
# Cloud Run IAM actually gate the daily Scheduler tick.
resource "google_cloud_run_v2_service" "pruner" {
  name     = "${local.prefix}-pruner"
  location = var.region
  template {
    service_account = data.terraform_remote_state.base.outputs.sa_pruner_email
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      dynamic "env" {
        for_each = merge(local.shared_env, { WORKER_ROLE = "pruner" })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.outbox_env
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
    service_account = data.terraform_remote_state.base.outputs.sa_dlq_email
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
