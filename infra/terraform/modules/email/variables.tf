variable "domain_name" {
  description = "Sending domain, for example montra.example."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone that holds the domain's DNS records."
  type        = string
}

variable "dmarc_policy" {
  description = "DMARC policy: none, quarantine or reject. Start with none or quarantine and tighten once reports look clean."
  type        = string
  default     = "quarantine"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "Use none, quarantine or reject."
  }
}

variable "dmarc_report_address" {
  description = "Mailbox for DMARC aggregate reports."
  type        = string
}
