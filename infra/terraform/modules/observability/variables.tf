variable "name" {
  description = "Prefix for resource names, for example montra-prod."
  type        = string
}

variable "kms_key_arn" {
  description = "Key for the alarm topic."
  type        = string
}

variable "alarm_emails" {
  description = "Addresses subscribed to the alarm topic. Each must confirm by email. Connect the topic to your pager as well."
  type        = list(string)
  default     = []
}

variable "metrics_namespace" {
  description = "CloudWatch namespace of the metrics the collector sidecar publishes from /internal/metrics."
  type        = string
}

variable "queues" {
  description = "Job queues to alarm on."
  type        = list(string)
}

variable "alb_arn_suffix" {
  description = "ALB identifier for metric dimensions."
  type        = string
}

variable "target_group_arn_suffixes" {
  description = "Target groups to watch for unhealthy hosts, as service => suffix. Blue/green services list both groups."
  type        = map(string)
}

variable "ecs_cluster_name" {
  description = "ECS cluster name."
  type        = string
}

variable "ecs_services" {
  description = "ECS services and the task count below which an alarm fires, as service => minimum."
  type        = map(number)
}

variable "aurora_cluster_identifier" {
  description = "Aurora cluster identifier."
  type        = string
}

variable "aurora_max_connections_alarm" {
  description = "Connection count on the writer that raises an alarm."
  type        = number
  default     = 400
}

variable "error_rate_threshold_percent" {
  description = "Share of API requests answered with 5xx that raises an alarm. At 1%, the 99.9% monthly budget lasts about 3 days."
  type        = number
  default     = 1
}

variable "queue_lag_threshold_seconds" {
  description = "Queue lag that raises an alarm. The SLO is p95 under 30 s; this is the level at which users notice."
  type        = number
  default     = 120
}
