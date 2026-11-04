variable "name" {
  description = "Prefix for key aliases, for example montra-prod."
  type        = string
}

variable "backup_account_id" {
  description = "Account that receives backup copies. It gets use of the database key so it can copy and restore snapshots (BAK-02). Null when there is no cross-account copy."
  type        = string
  default     = null
}

variable "deletion_window_in_days" {
  description = "Days a key waits before deletion once scheduled."
  type        = number
  default     = 30
}
