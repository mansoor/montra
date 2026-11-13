variable "environment" {
  description = "Environment name: dev, staging or prod."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Use dev, staging or prod."
  }
}

variable "domain_name" {
  description = "Base domain of this environment. The services use app., api. and auth. under it, and email is sent from it."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone of domain_name. Use one zone per environment, see the edge module."
  type        = string
}

variable "bucket_prefix" {
  description = "Globally unique prefix for the S3 buckets."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC."
  type        = string
}

variable "github_repository" {
  description = "Repository allowed to deploy, as owner/name."
  type        = string
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider. Set false if another environment in the same AWS account already made it."
  type        = bool
  default     = true
}

variable "alarm_emails" {
  description = "Addresses that receive alarms."
  type        = list(string)
  default     = []
}

variable "support_email" {
  description = "Support address shown to users."
  type        = string
}

variable "dmarc_report_address" {
  description = "Mailbox for DMARC aggregate reports."
  type        = string
}

variable "dmarc_policy" {
  description = "DMARC policy: none, quarantine or reject."
  type        = string
  default     = "quarantine"
}

variable "billing_mode" {
  description = "Set as BILLING_MODE."
  type        = string
  default     = "stripe"
}

variable "stripe_price_pro_monthly" {
  description = "Stripe price id for Pro monthly."
  type        = string
  default     = ""
}

variable "stripe_price_pro_yearly" {
  description = "Stripe price id for Pro yearly."
  type        = string
  default     = ""
}

variable "extra_environment" {
  description = "More plain environment variables for the API and worker."
  type        = map(string)
  default     = {}
}

variable "image_tag" {
  description = "Tag for task definitions that Terraform registers. Deployments replace it."
  type        = string
  default     = "bootstrap"
}

# Sizing and safety, set per environment in envs/*/main.tf.

variable "availability_zone_count" {
  description = "Availability zones to use."
  type        = number
  default     = 3
}

variable "single_nat_gateway" {
  description = "One NAT gateway instead of one per AZ. Dev only."
  type        = bool
  default     = false
}

variable "protect_from_deletion" {
  description = "Deletion protection on the ALB and Aurora, final snapshots, and a recovery window on secrets. Off for dev only."
  type        = bool
  default     = true
}

variable "db_instance_class" {
  description = "Aurora instance class."
  type        = string
}

variable "db_instance_count" {
  description = "Aurora instances: one writer, the rest readers."
  type        = number
  default     = 2
}

variable "db_backup_retention_days" {
  description = "Point-in-time recovery window. BAK-01 requires 35."
  type        = number
  default     = 35
}

variable "services" {
  description = "Size and counts per service, see the compute module."
  type = object({
    api            = object({ cpu = number, memory = number, min = number, max = number })
    worker         = object({ cpu = number, memory = number, min = number, max = number })
    web            = object({ cpu = number, memory = number, min = number, max = number })
    doc_worker     = object({ cpu = number, memory = number, desired = number })
    kratos         = object({ cpu = number, memory = number, desired = number })
    auth_gateway   = object({ cpu = number, memory = number, desired = number })
    kratos_courier = object({ cpu = number, memory = number })
  })
}

variable "deployment_config_name" {
  description = "CodeDeploy traffic-shifting config."
  type        = string
  default     = "CodeDeployDefault.ECSCanary10Percent5Minutes"
}

variable "cross_account_backup_enabled" {
  description = "Copy backups to the separate backup account (BAK-02)."
  type        = bool
  default     = true
}

variable "backup_account_id" {
  description = "Id of the backup account. Required when cross_account_backup_enabled is true."
  type        = string
  default     = null
}

variable "vault_lock_enabled" {
  description = "Vault Lock in compliance mode on every backup vault (BAK-02). Permanent after the cooling-off period."
  type        = bool
  default     = true
}

variable "vault_lock_changeable_for_days" {
  description = "Cooling-off period before a vault lock becomes permanent."
  type        = number
  default     = 3
}

variable "managed_waf_enabled" {
  description = "Deploy Cloudflare's managed rulesets. Needs a Pro plan or higher."
  type        = bool
  default     = true
}

variable "rate_limit_period_seconds" {
  description = "Rate-limit counting period, limited by the Cloudflare plan."
  type        = number
  default     = 60
}

variable "rate_limit_count_failures_only" {
  description = "Count only failed attempts towards the managed challenge. Needs a Cloudflare plan with custom counting expressions."
  type        = bool
  default     = false
}
