variable "name" {
  description = "Prefix for IAM role names, for example montra-prod."
  type        = string
}

variable "bucket_name" {
  description = "Name of the file bucket. S3 names are global, so include something unique to you."
  type        = string
}

variable "replica_bucket_name" {
  description = "Name of the replica bucket in the second region."
  type        = string
}

variable "kms_key_arn" {
  description = "Key for the primary bucket."
  type        = string
}

variable "replica_kms_key_arn" {
  description = "Key for the replica bucket, in the second region."
  type        = string
}

variable "noncurrent_version_days" {
  description = "Days a deleted or overwritten file stays recoverable (BAK-03)."
  type        = number
  default     = 30
}

variable "force_destroy" {
  description = "Allow Terraform to delete non-empty buckets. Leave false outside dev."
  type        = bool
  default     = false
}
