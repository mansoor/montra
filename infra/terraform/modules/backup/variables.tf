variable "name" {
  description = "Prefix for resource names, for example montra-prod."
  type        = string
}

variable "resource_arns" {
  description = "Resources to back up, in practice the Aurora cluster."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "Key for the primary vault."
  type        = string
}

variable "replica_kms_key_arn" {
  description = "Key for the vault in the second region."
  type        = string
}

variable "daily_retention_days" {
  description = "Days to keep daily snapshots (BAK-01)."
  type        = number
  default     = 35
}

variable "monthly_retention_days" {
  description = "Days to keep monthly snapshots. 365 is the 12 months in BAK-01."
  type        = number
  default     = 365
}

variable "daily_schedule" {
  description = "Cron expression for the daily snapshot, in UTC."
  type        = string
  default     = "cron(0 4 ? * * *)"
}

variable "monthly_schedule" {
  description = "Cron expression for the monthly snapshot, in UTC."
  type        = string
  default     = "cron(0 5 1 * ? *)"
}

variable "cross_account_copy_enabled" {
  description = "Copy each backup to a vault in the separate backup account (BAK-02). Needs cross-account backup turned on for the AWS Organization."
  type        = bool
  default     = true
}

variable "source_account_id" {
  description = "Account that holds the database. The backup account's vault lets it copy in. Required when cross_account_copy_enabled is true."
  type        = string
  default     = null
}

variable "vault_lock_enabled" {
  description = "Put a Vault Lock on every vault (BAK-02). Once the cooling-off period ends, this can't be undone by anyone, including AWS: backups stay and are billed until they age out."
  type        = bool
  default     = true
}

variable "vault_lock_changeable_for_days" {
  description = "Cooling-off period before the lock becomes permanent. Setting a value is what makes it compliance mode. AWS's minimum is 3."
  type        = number
  default     = 3

  validation {
    condition     = var.vault_lock_changeable_for_days >= 3
    error_message = "AWS needs at least 3 days of cooling-off for a compliance-mode lock."
  }
}
