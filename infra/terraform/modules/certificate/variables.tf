variable "hostnames" {
  description = "Hostnames on the certificate. The first one is the certificate's main name."
  type        = list(string)
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone that holds the DNS validation records."
  type        = string
}
