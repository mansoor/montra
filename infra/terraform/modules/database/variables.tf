variable "name" {
  description = "Prefix for resource names, for example montra-prod."
  type        = string
}

variable "vpc_id" {
  description = "VPC of the cluster."
  type        = string
}

variable "subnet_ids" {
  description = "Database subnets, in at least two availability zones."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups that may connect on port 5432."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "Key for storage, snapshots, the master password secret and Performance Insights (NFR-01)."
  type        = string
}

variable "engine_major_version" {
  description = "Aurora PostgreSQL major version. The newest minor is used at creation; minors then upgrade in the maintenance window."
  type        = string
  default     = "16"
}

variable "instance_class" {
  description = "Instance class for the writer and readers."
  type        = string
}

variable "instance_count" {
  description = "Instances in total: one writer, the rest readers. Two or more gives Multi-AZ failover and the reporting reader."
  type        = number
  default     = 2

  validation {
    condition     = var.instance_count >= 1
    error_message = "A cluster needs at least one instance."
  }
}

variable "backup_retention_days" {
  description = "Point-in-time recovery window in days. BAK-01 requires 35 in production."
  type        = number
  default     = 35

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "Aurora allows 1 to 35 days."
  }
}

variable "deletion_protection" {
  description = "Protect the cluster from deletion and take a final snapshot if it is ever removed."
  type        = bool
  default     = true
}

variable "preferred_backup_window" {
  description = "Daily window for Aurora's automated backup, in UTC."
  type        = string
  default     = "03:00-04:00"
}

variable "preferred_maintenance_window" {
  description = "Weekly maintenance window, in UTC."
  type        = string
  default     = "sun:05:00-sun:06:00"
}
