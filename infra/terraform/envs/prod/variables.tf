variable "region" {
  description = "Primary AWS region."
  type        = string
}

variable "replica_region" {
  description = "Second AWS region, for backup copies, the file replica and KMS replicas (BAK-02, BAK-03)."
  type        = string
}

variable "backup_account_id" {
  description = "Id of the separate AWS account that receives backup copies (BAK-02)."
  type        = string
}

variable "backup_account_role_name" {
  description = "Role in the backup account that Terraform assumes to manage the vault there."
  type        = string
  default     = "montra-terraform"
}

variable "domain_name" {
  description = "Base domain of this environment. The services use app., api. and auth. under it."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone of domain_name. Use a separate zone per environment."
  type        = string
}

variable "bucket_prefix" {
  description = "Globally unique prefix for S3 bucket names."
  type        = string
}

variable "github_repository" {
  description = "Repository allowed to deploy, as owner/name."
  type        = string
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider. Set false if another environment in this AWS account already made it."
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

variable "billing_mode" {
  description = "Set as BILLING_MODE on the API and worker."
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

variable "managed_waf_enabled" {
  description = "Deploy Cloudflare's managed rulesets. Needs a Pro plan or higher on the zone."
  type        = bool
  default     = true
}

variable "rate_limit_period_seconds" {
  description = "Rate-limit counting period, limited by the Cloudflare plan (Free 10, Pro up to 60, Business up to 600)."
  type        = number
  default     = 60
}

variable "rate_limit_count_failures_only" {
  description = "Count only failed attempts towards the managed challenge. Needs a Cloudflare plan with custom counting expressions."
  type        = bool
  default     = false
}

variable "image_tag" {
  description = "Image tag for the task definitions Terraform registers. Set it once, to the tag from the first build_only run of deploy.yml. Later deployments replace it."
  type        = string
  default     = "bootstrap"
}
