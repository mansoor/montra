variable "cloudflare_zone_id" {
  description = "Cloudflare zone of this environment. Give each environment its own zone: a zone has one ruleset per phase, so two environments sharing a zone would overwrite each other's rules."
  type        = string
}

variable "origin_hostname" {
  description = "ALB DNS name that the proxied records point at."
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

variable "managed_waf_enabled" {
  description = "Deploy the Cloudflare Managed and OWASP rulesets. Needs a Pro plan or higher."
  type        = bool
  default     = true
}

variable "count_failures_only" {
  description = "Count only failed attempts towards the managed challenge, using the response code. Needs a plan that supports a custom counting expression (Business or higher). When false, every POST counts."
  type        = bool
  default     = false
}

variable "challenge_requests_per_period" {
  description = "Attempts per period from one IP before a managed challenge (AUTH-08)."
  type        = number
  default     = 5
}

variable "block_requests_per_period" {
  description = "Attempts per period from one IP before requests are blocked outright."
  type        = number
  default     = 20
}

variable "rate_limit_period_seconds" {
  description = "Counting period. Plans limit the allowed values: Free 10, Pro up to 60, Business up to 600."
  type        = number
  default     = 60
}

variable "block_timeout_seconds" {
  description = "How long a block lasts."
  type        = number
  default     = 600
}
