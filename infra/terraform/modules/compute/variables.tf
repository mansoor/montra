variable "name" {
  description = "Prefix for resource names, for example montra-prod. Also the ECS cluster name."
  type        = string
}

variable "environment" {
  description = "Environment name: dev, staging or prod."
  type        = string
}

variable "vpc_id" {
  description = "VPC of the services."
  type        = string
}

variable "private_subnet_ids" {
  description = "Subnets for the tasks."
  type        = list(string)
}

variable "app_security_group_id" {
  description = "Security group shared by the tasks."
  type        = string
}

variable "https_listener_arn" {
  description = "ALB HTTPS listener to add host rules to."
  type        = string
}

variable "test_listener_arn" {
  description = "ALB listener for CodeDeploy's test route. Not reachable from the internet."
  type        = string
}

variable "hostnames" {
  description = "Public hostnames: web, api and auth."
  type = object({
    web  = string
    api  = string
    auth = string
  })
}

variable "cookie_domain" {
  description = "Parent domain for Kratos cookies, shared by the web, api and auth hostnames."
  type        = string
}

variable "image_tag" {
  description = "Image tag for task definitions Terraform registers. Deployments replace it with the tag they built, so this only matters for the first revision."
  type        = string
  default     = "bootstrap"
}

variable "s3_bucket_name" {
  description = "File bucket. Set as S3_BUCKET."
  type        = string
}

variable "s3_bucket_arn" {
  description = "File bucket ARN."
  type        = string
}

variable "storage_key_arn" {
  description = "KMS key of the file bucket."
  type        = string
}

variable "data_key_arn" {
  description = "KMS key for field-level encryption. Set as AWS_KMS_KEY_ID."
  type        = string
}

variable "ops_key_arn" {
  description = "KMS key for Secrets Manager."
  type        = string
}

variable "secret_recovery_window_days" {
  description = "Days a deleted secret can be restored. 0 deletes at once; use that for dev only."
  type        = number
  default     = 30
}

variable "mail_from" {
  description = "Sender for application email. Set as MAIL_FROM, for example \"Montra <no-reply@montra.example>\"."
  type        = string
}

variable "kratos_from_address" {
  description = "Sender address for Kratos recovery and verification email."
  type        = string
}

variable "support_email" {
  description = "Support address shown to users. Set as SUPPORT_EMAIL."
  type        = string
}

variable "billing_mode" {
  description = "Set as BILLING_MODE. The value must be one the API's config accepts."
  type        = string
  default     = "stripe"
}

variable "extra_environment" {
  description = "More plain environment variables for the API and worker."
  type        = map(string)
  default     = {}
}

variable "services" {
  description = "Size and task counts per service. `desired` is the initial count. api needs a minimum of two tasks (NFR-08)."
  type = object({
    api            = object({ cpu = number, memory = number, min = number, max = number })
    worker         = object({ cpu = number, memory = number, min = number, max = number })
    web            = object({ cpu = number, memory = number, min = number, max = number })
    doc_worker     = object({ cpu = number, memory = number, desired = number })
    kratos         = object({ cpu = number, memory = number, desired = number })
    auth_gateway   = object({ cpu = number, memory = number, desired = number })
    kratos_courier = object({ cpu = number, memory = number })
  })

  validation {
    condition     = var.services.api.min >= 2
    error_message = "The api service needs at least two tasks, one per availability zone."
  }
}

variable "worker_scaling_queues" {
  description = "Queues whose lag drives worker autoscaling. `schedule` is left out: its jobs wait for their due time, and the doc queue belongs to the doc worker."
  type        = list(string)
  default     = ["import", "ai", "report"]
}

variable "worker_scaling_target_lag_seconds" {
  description = "Queue lag the worker autoscaler aims for. The SLO is p95 under 30 s (design 07 §7)."
  type        = number
  default     = 30
}

variable "metrics_namespace" {
  description = "CloudWatch namespace the collector sidecar publishes to."
  type        = string
}

variable "collector_image" {
  description = "AWS Distro for OpenTelemetry image used as the metrics sidecar on API tasks."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
}

variable "log_retention_days" {
  description = "Days to keep container logs."
  type        = number
  default     = 90
}

variable "deployment_config_name" {
  description = "CodeDeploy traffic-shifting config for the blue/green services."
  type        = string
  default     = "CodeDeployDefault.ECSCanary10Percent5Minutes"
}

variable "termination_wait_minutes" {
  description = "How long the old (blue) tasks stay up after traffic moves, which is the window for an instant rollback."
  type        = number
  default     = 15
}

variable "rollback_alarm_names" {
  description = "CloudWatch alarms that roll a blue/green deployment back when they fire."
  type        = list(string)
  default     = []
}
